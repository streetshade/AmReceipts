import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import AppHeader from "@/components/AppHeader";
import AdminClient, { type AdminUser, type AdminGroup } from "./AdminClient";
import ReasonManager, { type ManagedReason } from "@/components/ReasonManager";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/dashboard");

  const [users, groups, reasons] = await Promise.all([
    prisma.user.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, role: true, active: true, company: true, title: true, groupId: true },
    }),
    prisma.group.findMany({
      orderBy: { name: "asc" },
      include: { approver: { select: { id: true, name: true } }, _count: { select: { members: true } } },
    }),
    prisma.reason.findMany({ orderBy: { label: "asc" }, include: { group: { select: { name: true } } } }),
  ]);

  const managedReasons: ManagedReason[] = reasons.map((r) => ({
    id: r.id,
    label: r.label,
    active: r.active,
    groupId: r.groupId,
    groupName: r.group?.name ?? null,
  }));

  const adminUsers: AdminUser[] = users;
  const adminGroups: AdminGroup[] = groups.map((g) => ({
    id: g.id,
    name: g.name,
    approverId: g.approverId,
    approverName: g.approver?.name ?? null,
    memberCount: g._count.members,
  }));

  return (
    <>
      <AppHeader userName={me.name} role={me.role} />
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Administration</h1>
            <p className="text-sm text-muted">Manage account access, groups and integrations.</p>
          </div>
          <Link href="/admin/integrations" className="btn-secondary">
            Integrations →
          </Link>
        </div>
        <AdminClient users={adminUsers} groups={adminGroups} currentUserId={me.id} />

        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Reasons</h2>
          <p className="text-sm text-muted">
            Optional reasons users can attach to an expense session. Scope to a group, or make one global (all groups).
          </p>
          <ReasonManager
            reasons={managedReasons}
            groups={adminGroups.map((g) => ({ id: g.id, name: g.name }))}
            allowGlobal
          />
        </section>
      </main>
    </>
  );
}
