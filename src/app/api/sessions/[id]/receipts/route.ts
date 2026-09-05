import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { handler, json, error, requireUserId } from "@/lib/api";
import { getOcrProvider } from "@/lib/providers/ocr";
import { extractPdfText, parsePdfText } from "@/lib/providers/pdf";
import { reconcilePaymentMethod } from "@/lib/payments";

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
  if (!(file instanceof File)) return error("An image or PDF file is required", 422);
  if (file.size === 0) return error("The file is empty", 422);
  if (file.size > MAX_BYTES) return error("File exceeds the 12MB limit", 413);

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
      data: { sessionId: session.id, imagePath, status: "failed" },
    });
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

  const receipt = await prisma.receipt.create({
    data: {
      sessionId: session.id,
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

  return json({ receipt }, 201);
});
