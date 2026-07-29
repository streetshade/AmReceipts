import { prisma } from "./db";

/** Loads a fully-populated session scoped to the owner, or null. */
export async function loadSession(sessionId: string, userId: string) {
  const session = await prisma.expenseSession.findFirst({
    where: { id: sessionId, userId },
    include: {
      job: true,
      reason: { select: { id: true, label: true } },
      approvedBy: { select: { name: true } },
      receipts: {
        orderBy: { createdAt: "asc" },
        include: {
          paymentMethod: true,
          lineItems: {
            orderBy: { createdAt: "asc" },
            include: { scannedItem: true },
          },
        },
      },
      scannedItems: {
        orderBy: { createdAt: "asc" },
        include: { product: true, lineItem: true },
      },
    },
  });
  return session;
}

export type LoadedSession = NonNullable<Awaited<ReturnType<typeof loadSession>>>;

/** Aggregate totals for a session. */
export function sessionTotals(session: LoadedSession) {
  const receiptTotal = session.receipts.reduce((acc, r) => acc + (r.total ?? 0), 0);
  const itemCount = session.scannedItems.reduce((acc, i) => acc + i.quantity, 0);
  const linkedCount = session.scannedItems.filter((i) => i.lineItemId).length;
  return { receiptTotal, itemCount, linkedCount, receiptCount: session.receipts.length };
}
