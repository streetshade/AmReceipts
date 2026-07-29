import { prisma } from "../db";

export interface ExportSessionRow {
  owner: string;
  title: string;
  company: string;
  session: string;
  project: string;
  reason: string; // managed catalog reason
  travelMeeting: string; // free-form travel/meeting reason
  payment: string;
  approval: string;
  submitted: string;
  created: string;
  totalCents: number;
}

/** Session-level rows behind a report, for CSV export. */
export async function exportSessionRows(userIds: string[]): Promise<ExportSessionRow[]> {
  if (userIds.length === 0) return [];
  const sessions = await prisma.expenseSession.findMany({
    where: { userId: { in: userIds } },
    orderBy: [{ createdAt: "desc" }],
    include: {
      job: true,
      reason: { select: { label: true } },
      user: { select: { name: true, title: true, company: true } },
      receipts: { select: { total: true, paymentMethod: { select: { label: true } } } },
    },
  });

  return sessions.map((s) => {
    const payments = [...new Set(s.receipts.map((r) => r.paymentMethod?.label).filter(Boolean) as string[])];
    return {
      owner: s.user.name,
      title: s.user.title ?? "",
      company: s.user.company ?? "",
      session: s.name,
      project: s.job ? (s.job.name ? `${s.job.number} — ${s.job.name}` : s.job.number) : "",
      reason: s.reason?.label ?? "",
      travelMeeting:
        s.reasonType && s.reasonType !== "job" ? (s.reasonNote ? `${s.reasonType}: ${s.reasonNote}` : s.reasonType) : "",
      payment: payments.join("; "),
      approval: s.approvalStatus,
      submitted: s.submittedAt ? s.submittedAt.toISOString().slice(0, 10) : "",
      created: s.createdAt.toISOString().slice(0, 10),
      totalCents: s.receipts.reduce((acc, r) => acc + (r.total ?? 0), 0),
    };
  });
}
