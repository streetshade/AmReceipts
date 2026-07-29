import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import AppHeader from "@/components/AppHeader";
import AdminClient, { type AdminUser, type AdminGroup } from "./AdminClient";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/dashboard");

  const [users, groups] = await Promise.all([
    prisma.user.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, role: true, active: true, company: true, title: true, groupId: true },
    }),
    prisma.group.findMany({
      orderBy: { name: "asc" },
      include: { approver: { select: { id: true, name: true } }, _count: { select: { members: true } } },
    }),
  ]);

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
      </main>
    </>
  );
}
