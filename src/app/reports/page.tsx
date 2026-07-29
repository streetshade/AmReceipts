import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { buildReport, type ReportData, type ReportRow } from "@/lib/reports";
import { reportableUserIds, overseenUserIds } from "@/lib/access";
import { formatCents } from "@/lib/money";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

function ReportTable({ title, rows, empty }: { title: string; rows: ReportRow[]; empty: string }) {
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-line px-4 py-3 font-semibold">{title}</div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted">{empty}</p>
      ) : (
        <table className="w-full text-sm">
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="px-4 py-2.5">{r.label}</td>
                <td className="px-4 py-2.5 text-right font-medium">{formatCents(r.receiptTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ExportLinks({ scope }: { scope: "self" | "team" }) {
  return (
    <div className="flex gap-2">
      <a className="btn-secondary" href={`/api/reports/export?scope=${scope}&format=csv`}>
        Export CSV
      </a>
      <a className="btn-secondary" href={`/api/reports/export?scope=${scope}&format=pdf`}>
        Export PDF
      </a>
    </div>
  );
}

function Kpis({ report }: { report: ReportData }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <div className="card border-l-2 border-l-gold p-4">
        <div className="text-xs uppercase tracking-wide text-muted">Total spend</div>
        <div className="text-2xl font-bold text-gold">{formatCents(report.grandTotal)}</div>
      </div>
      <div className="card p-4">
        <div className="text-xs uppercase tracking-wide text-muted">Sessions</div>
        <div className="text-2xl font-bold">{report.sessionCount}</div>
      </div>
      <div className="card p-4">
        <div className="text-xs uppercase tracking-wide text-muted">Unassigned</div>
        <div className="text-2xl font-bold">{formatCents(report.unassignedTotal)}</div>
      </div>
    </div>
  );
}

export default async function ReportsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const self = await buildReport([user.id]);

  // Approvers/admins additionally see a team report for those they oversee.
  const isOverseer = user.role === "approver" || user.role === "admin";
  let team: ReportData | null = null;
  let overseenCount = 0;
  if (isOverseer) {
    const ids = await reportableUserIds(user);
    overseenCount = user.role === "admin" ? ids.length : (await overseenUserIds(user.id)).length;
    team = await buildReport(ids);
  }

  return (
    <>
      <AppHeader userName={user.name} role={user.role} />
      <main className="mx-auto max-w-4xl space-y-8 px-4 py-6">
        <section className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold">Your expenses</h1>
              <p className="text-sm text-muted">
                {user.title ? `${user.title}${user.company ? `, ${user.company}` : ""}` : "Personal report"}
              </p>
            </div>
            <ExportLinks scope="self" />
          </div>
          <Kpis report={self} />
          <div className="grid gap-4 md:grid-cols-2">
            <ReportTable title="By project" rows={self.byJob} empty="No sessions assigned to a project yet." />
            <ReportTable title="By reason" rows={self.byReasonCatalog} empty="No reasons attached yet." />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <ReportTable title="By title" rows={self.byTitle} empty="No expenses recorded yet." />
            <ReportTable title="By travel / meeting" rows={self.byReason} empty="No travel or meeting sessions yet." />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <ReportTable title="By payment method" rows={self.byPaymentMethod} empty="No receipts recorded yet." />
          </div>
        </section>

        {team && (
          <section className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">Team expenses</h2>
                <p className="text-sm text-muted">
                  {user.role === "admin"
                    ? "All accounts"
                    : `${overseenCount} team member${overseenCount === 1 ? "" : "s"} you oversee (plus yourself)`}
                </p>
              </div>
              <ExportLinks scope="team" />
            </div>
            <Kpis report={team} />
            <div className="grid gap-4 md:grid-cols-2">
              <ReportTable title="By person" rows={team.byPerson} empty="No team expenses yet." />
              <ReportTable title="By reason" rows={team.byReasonCatalog} empty="No reasons attached yet." />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <ReportTable title="By title" rows={team.byTitle} empty="No team expenses yet." />
              <ReportTable title="By project" rows={team.byJob} empty="No project spend yet." />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <ReportTable title="By travel / meeting" rows={team.byReason} empty="No travel or meeting sessions yet." />
              <ReportTable title="By payment method" rows={team.byPaymentMethod} empty="No receipts recorded yet." />
            </div>
          </section>
        )}
      </main>
    </>
  );
}
