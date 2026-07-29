import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatCents } from "@/lib/money";
import AppHeader from "@/components/AppHeader";
import ProfileCard from "@/components/ProfileCard";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [paymentMethods, jobs, group] = await Promise.all([
    prisma.paymentMethod.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { receipts: true } }, receipts: { select: { total: true } } },
    }),
    prisma.job.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      include: { sessions: { include: { receipts: { select: { total: true } } } } },
    }),
    user.groupId ? prisma.group.findUnique({ where: { id: user.groupId } }) : Promise.resolve(null),
  ]);

  return (
    <>
      <AppHeader userName={user.name} role={user.role} />
      <main className="mx-auto max-w-4xl space-y-6 px-4 py-6">
        <h1 className="text-xl font-semibold">Account</h1>

        <ProfileCard
          name={user.name}
          email={user.email}
          role={user.role}
          company={user.company}
          title={user.title}
          groupName={group?.name ?? null}
        />

        <section className="card overflow-hidden">
          <div className="border-b border-line px-4 py-3 font-semibold">Payment methods</div>
          <p className="px-4 pt-3 text-xs text-muted">
            Automatically added to your account when a receipt reveals the method used.
          </p>
          {paymentMethods.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted">None yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {paymentMethods.map((m) => (
                <li key={m.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <div className="font-medium">{m.label}</div>
                    <div className="text-xs text-muted capitalize">
                      {m.type}
                      {m._count.receipts ? ` · ${m._count.receipts} receipt${m._count.receipts === 1 ? "" : "s"}` : ""}
                    </div>
                  </div>
                  <div className="font-medium">
                    {formatCents(m.receipts.reduce((acc, r) => acc + (r.total ?? 0), 0))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card overflow-hidden">
          <div className="border-b border-line px-4 py-3 font-semibold">Jobs</div>
          {jobs.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted">No jobs yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {jobs.map((j) => {
                const total = j.sessions.reduce(
                  (acc, s) => acc + s.receipts.reduce((a, r) => a + (r.total ?? 0), 0),
                  0,
                );
                return (
                  <li key={j.id} className="flex items-center justify-between px-4 py-3">
                    <div>
                      <div className="font-medium">{j.number}</div>
                      {j.name && <div className="text-xs text-muted">{j.name}</div>}
                    </div>
                    <div className="text-right">
                      <div className="font-medium">{formatCents(total)}</div>
                      <div className="text-xs text-muted">
                        {j.sessions.length} session{j.sessions.length === 1 ? "" : "s"}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
