import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { handler, json, error, requireUserId } from "@/lib/api";
import { getOcrProvider } from "@/lib/providers/ocr";
import { extractPdfText, parsePdfText } from "@/lib/providers/pdf";
import { reconcilePaymentMethod } from "@/lib/payments";
import { forgetUpload } from "@/lib/uploads";

type Params = { params: { id: string } };

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");
const MAX_BYTES = 12 * 1024 * 1024; // 12MB

// Accepts a multipart form with an `image` file (a photo OR a PDF), stores it,
// extracts the details, and creates a receipt with its line items. Payment
// method is reconciled onto the user's account.
//
// PDFs take a different route on purpose. An online purchase gives you a PDF
// with a real text layer, so the characters are already exact - rasterising it
// and guessing them back with OCR would be strictly worse. The text goes
// straight to the parser, which also means PDFs work on every OCR_PROVIDER,
// including the offline stub.
export const POST = handler(async (req: Request, { params }: Params) => {
  const userId = requireUserId();
  const session = await prisma.expenseSession.findFirst({ where: { id: params.id, userId } });
  if (!session) return error("Session not found", 404);

  const form = await req.formData();
  const file = form.get("image");
  // Minted on the device at the moment of capture. Optional, so the classic
  // upload path is unaffected.
  const captureIdRaw = form.get("captureId");
  const captureId = typeof captureIdRaw === "string" && captureIdRaw.trim() !== "" ? captureIdRaw.trim() : null;
  if (!(file instanceof File)) return error("An image or PDF file is required", 422);
  if (file.size === 0) return error("The file is empty", 422);
  if (file.size > MAX_BYTES) return error("File exceeds the 12MB limit", 413);

  // Refused outright if this photograph was thrown away.
  //
  // The delete cannot reach a request already in the air, or a blob sitting in
  // the phone's offline queue, so this is the only place the two can be
  // reconciled. 410 rather than 404: the offline queue treats it as permanent
  // and stops retrying, which is what "the user deleted it" means.
  //
  // This early check is a courtesy - it saves running OCR on a photograph
  // nobody wants. It is not what makes the rule hold; see `refuseIfDiscarded`.
  if (captureId && (await isDiscarded(session.id, captureId))) {
    return error("That photo was deleted", 410);
  }

  // Answered before anything is written. A retry after a lost response finds
  // the receipt its first attempt created and returns it, rather than adding a
  // duplicate nobody asked for.
  if (captureId) {
    // Scoped to THIS session, which the caller has already been shown to own.
    // A bare lookup on the unique column would hand back any receipt whose
    // capture id somebody could guess or replay, including another user's.
    const already = await prisma.receipt.findFirst({
      where: { captureId, sessionId: session.id },
      include: { lineItems: true, paymentMethod: true },
    });
    if (already) return json({ receipt: already, duplicate: true }, 200);
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  // Trust the magic bytes, not the declared type. A PDF sent as image/jpeg
  // would otherwise be handed to an OCR engine that cannot read it, and an
  // executable renamed .pdf would be stored and later served as one.
  const isPdf = bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-";
  if (!isPdf && !file.type.startsWith("image/")) {
    return error("Only image files and PDFs are accepted", 422);
  }

  // Persist under /public/uploads (dev-grade storage; swap for object storage
  // in production).
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const ext = isPdf ? "pdf" : (file.type.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
  const filename = `${crypto.randomUUID()}.${ext}`;
  await fs.writeFile(path.join(UPLOAD_DIR, filename), bytes);
  const imagePath = `/uploads/${filename}`;

  // A PDF that turns out to be a scan has no text to read. That is not an
  // error the user made, and the existing manual-entry fallback handles it
  // exactly as well as a failed OCR run does - so say so plainly rather than
  // dragging in a rasteriser.
  const failedReceipt = async (message: string) => {
    const failed = await prisma.receipt.create({
      data: { sessionId: session.id, imagePath, status: "failed", captureId },
    });
    // An unreadable receipt is still a receipt, and still has to answer for
    // having been thrown away while it was being read.
    const refused = await refuseIfDiscarded(session.id, captureId, failed);
    if (refused) return refused;
    return json({ id: failed.id, status: "failed", message }, 201);
  };

  let parsed;
  if (isPdf) {
    const extracted = await extractPdfText(bytes);
    if (!extracted.ok) {
      return failedReceipt(
        extracted.reason === "no_text_layer"
          ? "This PDF is a scan with no selectable text; you can enter the details manually."
          : `Could not read the PDF (${extracted.detail}); you can enter the details manually.`,
      );
    }
    parsed = parsePdfText(extracted.text);
  } else {
    try {
      parsed = await getOcrProvider().process(bytes, file.type);
    } catch (e) {
      // Store the receipt as failed rather than losing the image.
      return failedReceipt("OCR failed; you can enter details manually.");
    }
  }

  const paymentMethodId = await reconcilePaymentMethod(userId, parsed.paymentRaw);

  const receipt = await createReceiptOnce(session.id, captureId, {
    data: {
      sessionId: session.id,
      captureId,
      imagePath,
      merchant: parsed.merchant,
      purchaseDate: parsed.purchaseDate ? new Date(parsed.purchaseDate) : null,
      subtotal: parsed.subtotal,
      tax: parsed.tax,
      total: parsed.total,
      paymentRaw: parsed.paymentRaw,
      paymentMethodId,
      status: "processed",
      rawText: parsed.rawText,
      lineItems: {
        create: parsed.lineItems.map((li) => ({
          description: li.description,
          quantity: li.quantity,
          amount: li.amount,
        })),
      },
    },
    include: { lineItems: true, paymentMethod: true },
  });

  const refused = await refuseIfDiscarded(session.id, captureId, receipt);
  if (refused) return refused;

  return json({ receipt }, 201);
});

async function isDiscarded(sessionId: string, captureId: string): Promise<boolean> {
  const row = await prisma.discardedCapture.findUnique({
    where: { sessionId_captureId: { sessionId, captureId } },
    select: { id: true },
  });
  return Boolean(row);
}

/**
 * Undo this upload if the user threw the photograph away while it was running.
 *
 * The check at the top of the route is not enough on its own: between it and
 * the insert there is an OCR pass, seconds long, and a delete arriving in that
 * window would find no receipt to remove and then watch one appear.
 *
 * So the order here is deliberately create-then-check, mirroring the discard
 * route's write-then-look. Each side commits before it looks for the other, and
 * for both to miss, each read would have to precede the other's commit while
 * following its own - which cannot be arranged. One of them always removes the
 * receipt.
 *
 * What that buys is the STATE: a discarded capture never keeps a receipt. It is
 * not a promise about this response. An upload that commits, reads no
 * tombstone, and is then deleted by a discard landing microseconds later still
 * answers 201 - correctly, at the moment it was asked. The device reconciles on
 * its next refresh, and the receipt is already gone.
 */
async function refuseIfDiscarded(
  sessionId: string,
  captureId: string | null,
  receipt: { id: string; imagePath: string | null },
): Promise<Response | null> {
  if (!captureId) return null;
  if (!(await isDiscarded(sessionId, captureId))) return null;

  try {
    await prisma.receipt.delete({ where: { id: receipt.id } });
  } catch (e) {
    // P2025 is the expected race: the discard route deleted it first, which is
    // the outcome this exists to reach. Anything else is a real failure, and
    // swallowing it would leave a tombstoned receipt on the visit - with its
    // photograph unlinked underneath it - and tell the caller it was refused.
    if ((e as { code?: string }).code !== "P2025") throw e;
  }
  await forgetUpload(receipt.imagePath);
  return error("That photo was deleted", 410);
}

/**
 * Create the receipt, tolerating a concurrent request that got there first.
 *
 * The pre-flight lookup narrows the window but cannot close it: two retries of
 * the same capture can both find nothing and both proceed. The unique index
 * then rejects the second, and without this it would surface as a 500 for a
 * request whose work had in fact succeeded.
 */
async function createReceiptOnce(
  sessionId: string,
  captureId: string | null,
  args: Parameters<typeof prisma.receipt.create>[0],
) {
  try {
    return await prisma.receipt.create(args);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "P2002" && captureId) {
      const existing = await prisma.receipt.findFirst({
        where: { captureId, sessionId },
        include: { lineItems: true, paymentMethod: true },
      });
      if (existing) return existing;
    }
    throw e;
  }
}
