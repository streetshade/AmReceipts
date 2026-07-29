import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { overseenUserIds } from "@/lib/access";
import AppHeader from "@/components/AppHeader";
import ApprovalsClient, { type ApprovalRow } from "./ApprovalsClient";
import ReasonManager, { type ManagedReason } from "@/components/ReasonManager";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "approver" && user.role !== "admin") redirect("/dashboard");

  // Groups this approver oversees, and their reason catalog (for management).
  const myGroups =
    user.role === "admin"
      ? await prisma.group.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } })
      : await prisma.group.findMany({ where: { approverId: user.id }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  const groupReasons = await prisma.reason.findMany({
    where: { groupId: { in: myGroups.map((g) => g.id) } },
    orderBy: { label: "asc" },
    include: { group: { select: { name: true } } },
  });
  const managedReasons: ManagedReason[] = groupReasons.map((r) => ({
    id: r.id,
    label: r.label,
    active: r.active,
    groupId: r.groupId,
    groupName: r.group?.name ?? null,
  }));

  // Admins can act on everyone; approvers on their overseen group members.
  const ids =
    user.role === "admin"
      ? (await prisma.user.findMany({ select: { id: true } })).map((u) => u.id)
      : await overseenUserIds(user.id);

  const sessions = await prisma.expenseSession.findMany({
    where: { userId: { in: ids }, approvalStatus: { in: ["submitted", "approved", "rejected"] } },
    orderBy: [{ submittedAt: "desc" }],
    include: {
      job: true,
      user: { select: { name: true, title: true } },
      receipts: { select: { total: true } },
    },
  });

  const rows: ApprovalRow[] = sessions.map((s) => ({
    id: s.id,
    name: s.name,
    ownerName: s.user.name,
    ownerTitle: s.user.title,
    approvalStatus: s.approvalStatus,
    approvalNote: s.approvalNote,
    submittedAt: s.submittedAt ? s.submittedAt.toISOString() : null,
    project: s.job ? (s.job.name ? `${s.job.number} — ${s.job.name}` : s.job.number) : null,
    reason: s.reasonType && s.reasonType !== "job" ? (s.reasonNote ? `${s.reasonType}: ${s.reasonNote}` : s.reasonType) : null,
    total: s.receipts.reduce((acc, r) => acc + (r.total ?? 0), 0),
  }));

  return (
    <>
      <AppHeader userName={user.name} role={user.role} />
      <main className="mx-auto max-w-4xl space-y-8 px-4 py-6">
        <ApprovalsClient rows={rows} />

        {myGroups.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Reasons for your groups</h2>
            <p className="text-sm text-muted">
              Optional reasons the people you oversee can attach to an expense session.
            </p>
            <ReasonManager reasons={managedReasons} groups={myGroups} allowGlobal={false} />
          </section>
        )}
      </main>
    </>
  );
}
