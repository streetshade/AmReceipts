import { prisma } from "@/lib/db";
import { handler, json, requireUserId } from "@/lib/api";

export const dynamic = "force-dynamic";

// Payment methods accrued on the user's account (created as receipts reveal them).
export const GET = handler(async () => {
  const userId = requireUserId();
  const methods = await prisma.paymentMethod.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { receipts: true } } },
  });
  return json({
    paymentMethods: methods.map((m) => ({
      id: m.id,
      label: m.label,
      brand: m.brand,
      last4: m.last4,
      type: m.type,
      receiptCount: m._count.receipts,
    })),
  });
});
