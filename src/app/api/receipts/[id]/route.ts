import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireUserId } from "@/lib/api";
import { reconcilePaymentMethod } from "@/lib/payments";

type Params = { params: { id: string } };

async function ownReceipt(receiptId: string, userId: string) {
  return prisma.receipt.findFirst({
    where: { id: receiptId, session: { userId } },
    include: { lineItems: true, taxes: { orderBy: { code: "asc" } } },
  });
}

const LineItem = z.object({
  description: z.string().min(1).max(200),
  quantity: z.number().int().min(1).max(9999),
  amount: z.number().int(), // cents
});

/** One tax component. Rates are parts per million: 5% is 50000. */
const TaxComponent = z.object({
  code: z.enum(["GST", "PST", "QST", "HST", "SALES"]),
  ratePpm: z.number().int().min(0).max(1_000_000).nullable().optional(),
  amount: z.number().int(),
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
  // Where the receipt was issued. Per receipt, because the same technician
  // crosses the border in a day.
  country: z.string().length(2).nullable().optional(),
  region: z.string().max(3).nullable().optional(),
  // The tax total broken into its parts. Replaces the set wholesale.
  taxes: z.array(TaxComponent).max(6).optional(),
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

  // Duplicate codes are refused up front; the sum is checked inside the
  // transaction, against the tax the update will actually leave behind.
  if (body.taxes !== undefined) {
    const codes = body.taxes.map((t) => t.code);
    if (new Set(codes).size !== codes.length) return error("Each tax can only appear once", 422);
  }

  // If payment string was corrected, re-reconcile onto the account.
  let paymentMethodId = receipt.paymentMethodId;
  if (body.paymentRaw !== undefined) {
    paymentMethodId = await reconcilePaymentMethod(userId, body.paymentRaw);
  }

  const conflict = await prisma.$transaction(async (tx) => {
    // Re-read inside the transaction. Validating against a copy fetched
    // earlier lets two concurrent edits each pass a check the other
    // invalidates, and the components stop summing to the total.
    const current = await tx.receipt.findUniqueOrThrow({ where: { id: receipt.id }, select: { tax: true } });
    const nextTax = body.tax !== undefined ? body.tax : current.tax;

    if (body.taxes !== undefined) {
      const parts = body.taxes.reduce((sum, t) => sum + t.amount, 0);
      if (nextTax === null) {
        // No total to divide. Components describing nothing would be a number
        // finance could not reconcile.
        if (parts !== 0) return "Cannot split tax when the receipt has no tax total";
      } else if (parts !== nextTax) {
        return `The tax lines add up to ${(parts / 100).toFixed(2)} but the receipt's tax is ${(nextTax / 100).toFixed(2)}`;
      }
    }

    // Guarded on the tax this request validated against. A concurrent PATCH
    // that changes the total between the read above and this write makes the
    // condition miss, so the components can never be installed against a total
    // that has since moved - which a plain update could not prevent under
    // Postgres read-committed.
    const written = await tx.receipt.updateMany({
      where: { id: receipt.id, tax: current.tax },
      data: {
        merchant: body.merchant ?? undefined,
        purchaseDate:
          body.purchaseDate === undefined ? undefined : body.purchaseDate ? new Date(body.purchaseDate) : null,
        // `?? undefined` would treat an explicit null as "leave it alone", so
        // a value could never be cleared once set.
        subtotal: body.subtotal === undefined ? undefined : body.subtotal,
        tax: body.tax === undefined ? undefined : body.tax,
        total: body.total === undefined ? undefined : body.total,
        paymentRaw: body.paymentRaw === undefined ? undefined : body.paymentRaw,
        paymentMethodId,
        country: body.country === undefined ? undefined : body.country,
        region: body.region === undefined ? undefined : body.region,
        status: body.status ?? undefined,
      },
    });
    if (written.count === 0) {
      return "This receipt was changed while you were editing it. Reload and try again.";
    }

    if (body.taxes !== undefined) {
      // Replaced wholesale, like line items: a partial update would leave a
      // stale component behind whenever a region change removes one, and the
      // parts would stop summing to the total.
      await tx.receiptTax.deleteMany({ where: { receiptId: receipt.id } });
      for (const t of body.taxes) {
        await tx.receiptTax.create({
          data: { receiptId: receipt.id, code: t.code, ratePpm: t.ratePpm ?? null, amount: t.amount },
        });
      }
    } else if (body.tax !== undefined && body.tax !== current.tax) {
      // The total moved and no new split came with it, so whatever is stored
      // no longer describes it. Cleared rather than left to reconcile to the
      // wrong number - a stale split is worse than none, because it looks
      // authoritative.
      await tx.receiptTax.deleteMany({ where: { receiptId: receipt.id } });
    }

    if (body.lineItems) {
      // Replace line items wholesale. (Linked scanned items are detached via
      // the SetNull relation and can be re-linked by the user.)
      await tx.lineItem.deleteMany({ where: { receiptId: receipt.id } });
      for (const li of body.lineItems) {
        await tx.lineItem.create({
          data: { receiptId: receipt.id, description: li.description, quantity: li.quantity, amount: li.amount },
        });
      }
    }

    return null;
  });

  if (conflict) return error(conflict, 422);

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
