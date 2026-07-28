import { prisma } from "./db";

/**
 * Reconcile a raw payment string read off a receipt (e.g. "VISA ****1234")
 * against the user's saved payment methods, creating one if it's new.
 * Returns the PaymentMethod id, or null when nothing usable was read.
 */
export async function reconcilePaymentMethod(userId: string, raw: string | null): Promise<string | null> {
  if (!raw) return null;
  const label = raw.trim().toUpperCase();
  if (!label) return null;

  const last4Match = label.match(/(\d{4})\s*$/);
  const last4 = last4Match ? last4Match[1] : null;
  const brand = label.split(/\s|\*/)[0] || null;
  const type = /CASH/.test(label) ? "cash" : "card";

  const existing = await prisma.paymentMethod.findUnique({
    where: { userId_label: { userId, label } },
  });
  if (existing) return existing.id;

  const created = await prisma.paymentMethod.create({
    data: { userId, label, brand: type === "card" ? brand : null, last4, type },
  });
  return created.id;
}
