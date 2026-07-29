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
  byReasonCatalog: ReportRow[];
  byTitle: ReportRow[];
  byPerson: ReportRow[];
  byPaymentMethod: ReportRow[];
  unassignedTotal: number;
}

/**
 * Build an expenditure report across the given set of users' sessions.
 * Pass [userId] for a self report, or many ids for an approver/admin team report.
 */
export async function buildReport(userIds: string[]): Promise<ReportData> {
  if (userIds.length === 0) {
    return {
      grandTotal: 0,
      sessionCount: 0,
      byJob: [],
      byReason: [],
      byReasonCatalog: [],
      byTitle: [],
      byPerson: [],
      byPaymentMethod: [],
      unassignedTotal: 0,
    };
  }

  const sessions = await prisma.expenseSession.findMany({
    where: { userId: { in: userIds } },
    include: {
      job: true,
      reason: { select: { id: true, label: true } },
      user: { select: { id: true, name: true, title: true } },
      receipts: { select: { total: true, paymentMethod: { select: { label: true } } } },
    },
  });

  const byJob = new Map<string, ReportRow>();
  const byReason = new Map<string, ReportRow>();
  const byReasonCatalog = new Map<string, ReportRow>();
  const byTitle = new Map<string, ReportRow>();
  const byPerson = new Map<string, ReportRow>();
  const byPayment = new Map<string, ReportRow>();
  let grandTotal = 0;
  let unassignedTotal = 0;

  const bump = (map: Map<string, ReportRow>, key: string, label: string, amount: number, countSession: boolean) => {
    const row = map.get(key) ?? { key, label, sessionCount: 0, receiptTotal: 0 };
    row.receiptTotal += amount;
    if (countSession) row.sessionCount += 1;
    map.set(key, row);
  };

  for (const s of sessions) {
    const sessionTotal = s.receipts.reduce((acc, r) => acc + (r.total ?? 0), 0);
    grandTotal += sessionTotal;

    // By project (job) or travel/meeting reason.
    if (s.job) {
      const label = s.job.name ? `${s.job.number} — ${s.job.name}` : s.job.number;
      bump(byJob, s.job.id, label, sessionTotal, true);
    } else if (s.reasonType && s.reasonType !== "job") {
      const key = `${s.reasonType}:${s.reasonNote ?? ""}`;
      const label = s.reasonNote ? `${s.reasonType}: ${s.reasonNote}` : s.reasonType;
      bump(byReason, key, label, sessionTotal, true);
    } else {
      unassignedTotal += sessionTotal;
    }

    // By managed reason (catalog), where one is attached.
    if (s.reason) bump(byReasonCatalog, s.reason.id, s.reason.label, sessionTotal, true);

    // By job title of the session's owner.
    const title = s.user.title?.trim() || "No title";
    bump(byTitle, title, title, sessionTotal, true);

    // By person (useful for team reports).
    bump(byPerson, s.user.id, s.user.name, sessionTotal, true);

    // By payment method (per receipt).
    for (const r of s.receipts) {
      const label = r.paymentMethod?.label ?? "Unspecified";
      bump(byPayment, label, label, r.total ?? 0, false);
    }
  }

  const sortRows = (m: Map<string, ReportRow>) =>
    [...m.values()].sort((a, b) => b.receiptTotal - a.receiptTotal);

  return {
    grandTotal,
    sessionCount: sessions.length,
    byJob: sortRows(byJob),
    byReason: sortRows(byReason),
    byReasonCatalog: sortRows(byReasonCatalog),
    byTitle: sortRows(byTitle),
    byPerson: sortRows(byPerson),
    byPaymentMethod: sortRows(byPayment),
    unassignedTotal,
  };
}
