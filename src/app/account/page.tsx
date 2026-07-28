import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatCents } from "@/lib/money";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [paymentMethods, jobs] = await Promise.all([
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
  ]);

  return (
    <>
      <AppHeader userName={user.name} />
      <main className="mx-auto max-w-4xl space-y-6 px-4 py-6">
        <div>
          <h1 className="text-xl font-semibold">Account</h1>
          <p className="text-sm text-slate-500">
            {user.name} · {user.email}
          </p>
        </div>

        <section className="card overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-3 font-semibold">Payment methods</div>
          <p className="px-4 pt-3 text-xs text-slate-400">
            Automatically added to your account when a receipt reveals the method used.
          </p>
          {paymentMethods.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-slate-400">None yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {paymentMethods.map((m) => (
                <li key={m.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <div className="font-medium">{m.label}</div>
                    <div className="text-xs text-slate-400 capitalize">
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
          <div className="border-b border-slate-100 px-4 py-3 font-semibold">Jobs</div>
          {jobs.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-slate-400">No jobs yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {jobs.map((j) => {
                const total = j.sessions.reduce(
                  (acc, s) => acc + s.receipts.reduce((a, r) => a + (r.total ?? 0), 0),
                  0,
                );
                return (
                  <li key={j.id} className="flex items-center justify-between px-4 py-3">
                    <div>
                      <div className="font-medium">{j.number}</div>
                      {j.name && <div className="text-xs text-slate-400">{j.name}</div>}
                    </div>
                    <div className="text-right">
                      <div className="font-medium">{formatCents(total)}</div>
                      <div className="text-xs text-slate-400">
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
