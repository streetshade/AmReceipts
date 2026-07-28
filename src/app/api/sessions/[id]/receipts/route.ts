import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { handler, json, error, requireUserId } from "@/lib/api";
import { getOcrProvider } from "@/lib/providers/ocr";
import { reconcilePaymentMethod } from "@/lib/payments";

type Params = { params: { id: string } };

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");
const MAX_BYTES = 12 * 1024 * 1024; // 12MB

// Accepts a multipart form with an `image` file, stores it, runs OCR, and
// creates a receipt with its line items. Payment method is reconciled onto the
// user's account.
export const POST = handler(async (req: Request, { params }: Params) => {
  const userId = requireUserId();
  const session = await prisma.expenseSession.findFirst({ where: { id: params.id, userId } });
  if (!session) return error("Session not found", 404);

  const form = await req.formData();
  const file = form.get("image");
  if (!(file instanceof File)) return error("An image file is required", 422);
  if (file.size === 0) return error("The image is empty", 422);
  if (file.size > MAX_BYTES) return error("Image exceeds the 12MB limit", 413);

  const bytes = Buffer.from(await file.arrayBuffer());

  // Persist the image under /public/uploads (dev-grade storage; swap for object
  // storage in production).
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const ext = (file.type.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
  const filename = `${crypto.randomUUID()}.${ext}`;
  await fs.writeFile(path.join(UPLOAD_DIR, filename), bytes);
  const imagePath = `/uploads/${filename}`;

  // Run OCR through the configured provider.
  let parsed;
  try {
    parsed = await getOcrProvider().process(bytes, file.type);
  } catch (e) {
    // Store the receipt as failed rather than losing the image.
    const failed = await prisma.receipt.create({
      data: { sessionId: session.id, imagePath, status: "failed" },
    });
    return json({ id: failed.id, status: "failed", message: "OCR failed; you can enter details manually." }, 201);
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
