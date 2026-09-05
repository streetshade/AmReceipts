// Query layer for the posting audit trail.
//
// Built for one job: sitting next to M3 and answering "does what we attempted
// match what is actually in the ledger". That shapes two decisions.
//
// First, EVERY posting is visible, not just the successful ones. A reconciler
// most needs the `unknown` rows - the ones that may have posted without telling
// us - and those are exactly the rows a "show me what worked" view would hide.
//
// Second, results carry the attempt history, not just the final state. A row
// that reads "posted" after three attempts is a different investigation from
// one that posted first time.

import { prisma } from "../db";
import type { Prisma } from "@prisma/client";

export interface AuditFilters {
  /**
   * Admin view: no per-user restriction at all.
   *
   * Not the same as "userIds happens to contain everyone". Postings keep a
   * SNAPSHOT of their claimant, so a posting made by a since-deleted user has a
   * userId that matches no current User row - and would silently vanish from
   * the admin's view precisely when someone is auditing a departed employee's
   * spend. An admin sees rows, not people.
   */
  allUsers?: boolean;
  /** Visibility scope - the users this viewer may see. Applied unless allUsers. */
  userIds: string[];
  /** Narrow to one claimant within that scope. */
  userId?: string;
  /** Exact job number as snapshotted on the posting. */
  jobNumber?: string;
  status?: string;
  /**
   * Inclusive YYYY-MM-DD bounds on the ACCOUNTING date, not the row's creation
   * timestamp. Reconciliation is driven by the period a voucher lands in, and
   * accountingDate is stored as a plain date string, so the comparison has no
   * timezone to get wrong - a UTC-interpreted createdAt would shift a local
   * day boundary by hours and quietly drop postings at the edges of a period.
   */
  from?: string;
  to?: string;
  /** Matches a posting reference or an M3 voucher number. */
  search?: string;
  limit?: number;
  /** Raise the page cap for exports, which legitimately span a whole period. */
  maxLimit?: number;
  cursor?: string;
}

export interface AuditLine {
  lineNo: number;
  account: string;
  dimensions: (string | null)[];
  amountCents: number;
  taxCents: number;
  vatCode: string | null;
  description: string;
  viaSuspense: boolean;
  /** Provenance: which receipt, and which routing rules chose this account. */
  receiptId: string | null;
  routedBy: string[];
}

export interface AuditAttempt {
  attemptNo: number;
  outcome: string;
  ambiguous: boolean;
  /**
   * Whether this call was the one that commits the voucher. An ambiguous
   * attempt with commits=false staged a batch and left no voucher: the remedy
   * is to find and clear the unconfirmed batch, not to hunt for a posting.
   */
  commits: boolean;
  httpStatus: number | null;
  m3Message: string | null;
  voucherNo: string | null;
  program: string | null;
  transaction: string | null;
  /** The MI parameters actually sent, for comparing against M3 field by field. */
  requestParams: Record<string, string> | null;
  durationMs: number | null;
  actor: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface AuditRow {
  id: string;
  reference: string;
  sessionId: string;
  status: string;
  user: { id: string; name: string; email: string };
  job: { number: string | null; name: string | null };
  groupName: string | null;
  cono: string;
  divi: string;
  currency: string;
  amountCents: number;
  taxCents: number;
  accountingDate: string;
  documentType: string;
  postingProfileKey: string;
  supplierNo: string | null;
  voucherNo: string | null;
  voucherSeries: string | null;
  fiscalYear: string | null;
  attempts: number;
  lastError: string | null;
  postedAt: string | null;
  createdAt: string;
  lines: AuditLine[];
  attemptLog: AuditAttempt[];
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Hard ceiling regardless of caller, so one request cannot exhaust memory. */
const ABSOLUTE_MAX_LIMIT = 10_000;

/** True when the caller asked for a user they are not allowed to see. */
export function scopeDenies(f: AuditFilters): boolean {
  if (!f.userId) return false;
  if (f.allUsers) return false;
  return !f.userIds.includes(f.userId);
}

function buildWhere(f: AuditFilters): Prisma.M3PostingWhereInput {
  const where: Prisma.M3PostingWhereInput = {};

  // The visibility scope is non-negotiable. A caller-supplied userId can only
  // NARROW it: an out-of-scope request is refused by scopeDenies() rather than
  // quietly widened back to everything the viewer may see, which would make a
  // filter appear not to work.
  if (f.allUsers) {
    if (f.userId) where.userId = f.userId;
  } else {
    where.userId = f.userId ? f.userId : { in: f.userIds };
  }

  if (f.jobNumber) where.jobNumber = f.jobNumber;
  if (f.status) where.status = f.status;

  if (f.from || f.to) {
    // accountingDate is a YYYY-MM-DD string, which sorts lexically, so a plain
    // string range is both correct and inclusive of the whole end day.
    const accountingDate: Prisma.StringFilter = {};
    if (f.from) accountingDate.gte = f.from;
    if (f.to) accountingDate.lte = f.to;
    where.accountingDate = accountingDate;
  }

  if (f.search) {
    const term = f.search.trim();
    if (term) {
      where.OR = [
        { reference: { contains: term } },
        { voucherNo: { contains: term } },
      ];
    }
  }

  return where;
}

/** One page of the audit trail, newest first, with lines and attempt history. */
export async function queryAudit(filters: AuditFilters): Promise<{ rows: AuditRow[]; nextCursor: string | null }> {
  if (scopeDenies(filters)) return { rows: [], nextCursor: null };
  if (!filters.allUsers && filters.userIds.length === 0) return { rows: [], nextCursor: null };

  // The UI cap and the export cap are different numbers: clamping an export to
  // the screen's page size would silently truncate every reconciliation run.
  const cap = Math.min(filters.maxLimit ?? MAX_LIMIT, ABSOLUTE_MAX_LIMIT);
  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_LIMIT, 1), cap);

  const found = await prisma.m3Posting.findMany({
    where: buildWhere(filters),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // Fetch one extra to learn whether another page exists without a count.
    take: limit + 1,
    ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    include: {
      lines: { orderBy: { lineNo: "asc" } },
      attemptLog: { orderBy: { attemptNo: "asc" } },
    },
  });

  const page = found.slice(0, limit);
  const nextCursor = found.length > limit ? page[page.length - 1].id : null;

  return {
    rows: page.map((p) => ({
      id: p.id,
      reference: p.reference,
      sessionId: p.sessionId,
      status: p.status,
      user: { id: p.userId, name: p.userName, email: p.userEmail },
      job: { number: p.jobNumber, name: p.jobName },
      groupName: p.groupName,
      cono: p.cono,
      divi: p.divi,
      currency: p.currency,
      amountCents: p.amountCents,
      taxCents: p.taxCents,
      accountingDate: p.accountingDate,
      documentType: p.documentType,
      postingProfileKey: p.postingProfileKey,
      supplierNo: p.supplierNo,
      voucherNo: p.voucherNo,
      voucherSeries: p.voucherSeries,
      fiscalYear: p.fiscalYear,
      attempts: p.attempts,
      lastError: p.lastError,
      postedAt: p.postedAt ? p.postedAt.toISOString() : null,
      createdAt: p.createdAt.toISOString(),
      lines: p.lines.map((l) => ({
        lineNo: l.lineNo,
        account: l.dim1,
        dimensions: [l.dim2, l.dim3, l.dim4, l.dim5, l.dim6, l.dim7],
        amountCents: l.amountCents,
        taxCents: l.taxCents,
        vatCode: l.vatCode,
        description: l.description,
        viaSuspense: l.viaSuspense,
        receiptId: l.receiptId,
        routedBy: l.routedBy ? (JSON.parse(l.routedBy) as string[]) : [],
      })),
      attemptLog: p.attemptLog.map((a) => ({
        attemptNo: a.attemptNo,
        outcome: a.outcome,
        ambiguous: a.ambiguous,
        commits: a.commits,
        httpStatus: a.httpStatus,
        m3Message: a.m3Message,
        voucherNo: a.voucherNo,
        program: a.program,
        transaction: a.transaction,
        requestParams: a.requestParams ? (JSON.parse(a.requestParams) as Record<string, string>) : null,
        durationMs: a.durationMs,
        actor: a.actor,
        startedAt: a.startedAt.toISOString(),
        finishedAt: a.finishedAt ? a.finishedAt.toISOString() : null,
      })),
    })),
    nextCursor,
  };
}

/** Counts per status within the current filter, for the summary strip. */
export async function auditSummary(filters: AuditFilters) {
  if (scopeDenies(filters)) return {} as Record<string, number>;
  if (!filters.allUsers && filters.userIds.length === 0) return {} as Record<string, number>;
  const grouped = await prisma.m3Posting.groupBy({
    by: ["status"],
    where: buildWhere(filters),
    _count: { _all: true },
  });
  return Object.fromEntries(grouped.map((g) => [g.status, g._count._all])) as Record<string, number>;
}

/** Distinct job numbers present in the viewer's scope, for the filter dropdown. */
export async function auditJobNumbers(userIds: string[], allUsers = false): Promise<string[]> {
  if (!allUsers && userIds.length === 0) return [];
  const rows = await prisma.m3Posting.findMany({
    where: { ...(allUsers ? {} : { userId: { in: userIds } }), jobNumber: { not: null } },
    distinct: ["jobNumber"],
    select: { jobNumber: true },
    orderBy: { jobNumber: "asc" },
  });
  return rows.map((r) => r.jobNumber).filter((n): n is string => n !== null);
}

/** Claimants present in the viewer's scope, for the filter dropdown. */
export async function auditUsers(userIds: string[], allUsers = false): Promise<{ id: string; name: string }[]> {
  if (!allUsers && userIds.length === 0) return [];
  const rows = await prisma.m3Posting.findMany({
    where: allUsers ? {} : { userId: { in: userIds } },
    distinct: ["userId"],
    select: { userId: true, userName: true },
    orderBy: { userName: "asc" },
  });
  return rows.map((r) => ({ id: r.userId, name: r.userName }));
}
