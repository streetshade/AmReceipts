import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { buildReport, type ReportRow } from "@/lib/reports";
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

export default async function ReportsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const report = await buildReport(user.id);

  return (
    <>
      <AppHeader userName={user.name} />
      <main className="mx-auto max-w-4xl space-y-6 px-4 py-6">
        <h1 className="text-xl font-semibold">Expenditure report</h1>

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

        <ReportTable title="By job" rows={report.byJob} empty="No sessions assigned to a job yet." />
        <ReportTable title="By travel / meeting reason" rows={report.byReason} empty="No travel or meeting sessions yet." />
        <ReportTable title="By payment method" rows={report.byPaymentMethod} empty="No receipts recorded yet." />
      </main>
    </>
  );
}
