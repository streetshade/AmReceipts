import { prisma } from "./db";

export interface ReportRow {
  key: string;
  label: string;
  sessionCount: number;
  receiptTotal: number; // cents
}

export interface ReportData {
  grandTotal: number;
  sessionCount: number;
  byJob: ReportRow[];
  byReason: ReportRow[];
  byPaymentMethod: ReportRow[];
  unassignedTotal: number;
}

/** Build the expenditure report across all of a user's sessions. */
export async function buildReport(userId: string): Promise<ReportData> {
  const sessions = await prisma.expenseSession.findMany({
    where: { userId },
    include: {
      job: true,
      receipts: { select: { total: true, paymentMethod: { select: { label: true } } } },
    },
  });

  const byJob = new Map<string, ReportRow>();
  const byReason = new Map<string, ReportRow>();
  const byPayment = new Map<string, ReportRow>();
  let grandTotal = 0;
  let unassignedTotal = 0;

  const bump = (map: Map<string, ReportRow>, key: string, label: string, amount: number) => {
    const row = map.get(key) ?? { key, label, sessionCount: 0, receiptTotal: 0 };
    row.receiptTotal += amount;
    map.set(key, row);
  };

  for (const s of sessions) {
    const sessionTotal = s.receipts.reduce((acc, r) => acc + (r.total ?? 0), 0);
    grandTotal += sessionTotal;

    if (s.job) {
      const key = s.job.id;
      const label = s.job.name ? `${s.job.number} — ${s.job.name}` : s.job.number;
      bump(byJob, key, label, sessionTotal);
      byJob.get(key)!.sessionCount += 1;
    } else if (s.reasonType && s.reasonType !== "job") {
      const label = s.reasonNote ? `${s.reasonType}: ${s.reasonNote}` : s.reasonType;
      bump(byReason, `${s.reasonType}:${s.reasonNote ?? ""}`, label, sessionTotal);
      byReason.get(`${s.reasonType}:${s.reasonNote ?? ""}`)!.sessionCount += 1;
    } else {
      unassignedTotal += sessionTotal;
    }

    // Payment method breakdown is per-receipt.
    for (const r of s.receipts) {
      const label = r.paymentMethod?.label ?? "Unspecified";
      bump(byPayment, label, label, r.total ?? 0);
    }
  }

  const sortRows = (m: Map<string, ReportRow>) =>
    [...m.values()].sort((a, b) => b.receiptTotal - a.receiptTotal);

  return {
    grandTotal,
    sessionCount: sessions.length,
    byJob: sortRows(byJob),
    byReason: sortRows(byReason),
    byPaymentMethod: sortRows(byPayment),
    unassignedTotal,
  };
}
