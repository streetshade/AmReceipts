import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getUiVersion } from "@/lib/settings";
import { loadHomeSummary } from "@/lib/homeSummary";
import { siteLabel } from "@/lib/geo";
import AppHeader from "@/components/AppHeader";
import DashboardClient from "./DashboardClient";
import HomeScreen from "./field/HomeScreen";
import FieldTabBar from "./field/FieldTabBar";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const uiVersion = await getUiVersion();

  if (uiVersion === "field") {
    const [summary, jobs] = await Promise.all([
      loadHomeSummary(user),
      // The manual picker's contents, sent with the page rather than fetched:
      // it is the fallback for a phone that could not be located, and half of
      // those phones have no signal either.
      prisma.job.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: { id: true, number: true, name: true, address: true },
      }),
    ]);

    // No AppHeader and no max-w-4xl gutter: Home draws its own chrome, and the
    // desktop header on top of it would push the whole screen down a nav bar.
    // Fixed to the viewport, not `min-h`: Home is one screen and must not be
    // draggable, or the tab bar walks off the bottom.
    return (
      <div className="flex h-[100dvh] flex-col overflow-hidden bg-field-ground">
        <HomeScreen
          summary={summary}
          recentJobs={jobs.map((j) => ({ ...j, label: siteLabel(j) }))}
        />
        <FieldTabBar role={user.role} />
      </div>
    );
  }

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
