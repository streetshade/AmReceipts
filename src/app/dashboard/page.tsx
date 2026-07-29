import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import AppHeader from "@/components/AppHeader";
import DashboardClient from "./DashboardClient";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const sessions = await prisma.expenseSession.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    include: {
      job: true,
      receipts: { select: { total: true } },
      _count: { select: { receipts: true, scannedItems: true } },
    },
  });

  const shaped = sessions.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    reasonType: s.reasonType,
    reasonNote: s.reasonNote,
    job: s.job ? { number: s.job.number, name: s.job.name } : null,
    receiptCount: s._count.receipts,
    itemCount: s._count.scannedItems,
    total: s.receipts.reduce((acc, r) => acc + (r.total ?? 0), 0),
    createdAt: s.createdAt.toISOString(),
  }));

  return (
    <>
      <AppHeader userName={user.name} role={user.role} />
      <main className="mx-auto max-w-4xl px-4 py-6">
        <DashboardClient initialSessions={shaped} />
      </main>
    </>
  );
}
