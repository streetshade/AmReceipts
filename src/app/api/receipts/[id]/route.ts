import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireUserId } from "@/lib/api";
import { reconcilePaymentMethod } from "@/lib/payments";

type Params = { params: { id: string } };

async function ownReceipt(receiptId: string, userId: string) {
  return prisma.receipt.findFirst({
    where: { id: receiptId, session: { userId } },
    include: { lineItems: true },
  });
}

const LineItem = z.object({
  description: z.string().min(1).max(200),
  quantity: z.number().int().min(1).max(9999),
  amount: z.number().int(), // cents
  kind: z.enum(["item", "tax"]).optional(),
});

const PatchBody = z.object({
  merchant: z.string().max(200).nullable().optional(),
  purchaseDate: z.string().datetime().nullable().optional(),
  subtotal: z.number().int().nullable().optional(),
  tax: z.number().int().nullable().optional(),
  total: z.number().int().nullable().optional(),
  paymentRaw: z.string().max(120).nullable().optional(),
  status: z.enum(["processed", "verified"]).optional(),
  lineItems: z.array(LineItem).optional(),
});

// Verify / correct an OCR'd receipt. The whole header is user-editable, and the
// full line-item list can be replaced.
export const PATCH = handler(async (req: Request, { params }: Params) => {
  const userId = requireUserId();
  const receipt = await ownReceipt(params.id, userId);
  if (!receipt) return error("Receipt not found", 404);

  const parsed = PatchBody.safeParse(await req.json());
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Invalid input", 422);
  const body = parsed.data;

  // If payment string was corrected, re-reconcile onto the account.
  let paymentMethodId = receipt.paymentMethodId;
  if (body.paymentRaw !== undefined) {
    paymentMethodId = await reconcilePaymentMethod(userId, body.paymentRaw);
  }

  await prisma.$transaction(async (tx) => {
    await tx.receipt.update({
      where: { id: receipt.id },
      data: {
        merchant: body.merchant ?? undefined,
        purchaseDate:
          body.purchaseDate === undefined ? undefined : body.purchaseDate ? new Date(body.purchaseDate) : null,
        subtotal: body.subtotal ?? undefined,
        tax: body.tax ?? undefined,
        total: body.total ?? undefined,
        paymentRaw: body.paymentRaw ?? undefined,
        paymentMethodId,
        status: body.status ?? undefined,
      },
    });

    if (body.lineItems) {
      // Replace line items wholesale. (Linked scanned items are detached via
      // the SetNull relation and can be re-linked by the user.)
      await tx.lineItem.deleteMany({ where: { receiptId: receipt.id } });
      for (const li of body.lineItems) {
        await tx.lineItem.create({
          data: {
            receiptId: receipt.id,
            description: li.description,
            quantity: li.quantity,
            amount: li.amount,
            kind: li.kind ?? "item",
          },
        });
      }
    }
  });

  const updated = await ownReceipt(params.id, userId);
  return json({ receipt: updated });
});

export const DELETE = handler(async (_req: Request, { params }: Params) => {
  const userId = requireUserId();
  const receipt = await ownReceipt(params.id, userId);
  if (!receipt) return error("Receipt not found", 404);
  await prisma.receipt.delete({ where: { id: receipt.id } });
  return json({ ok: true });
});
