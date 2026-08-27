// The posting queue: enqueue, claim, and record outcomes against M3.
//
// The whole point of this module is that a voucher is posted at most once. Two
// rules carry that weight, and everything else is bookkeeping:
//
//   1. `reference` is unique and deterministic, so the same session can never
//      be enqueued twice, however many times approval fires.
//   2. An `unknown` outcome is TERMINAL for the queue. It is never retried
//      automatically. Someone - or the reconciler - has to look at M3 first.
//
// Deliberately independent of the routing resolver: it accepts an already-built
// document. That keeps "what should this be booked to" and "did it post" as
// separate problems with separate failure modes.

import { randomUUID } from "node:crypto";
import { prisma } from "../db";
import { postingReference } from "./reference";

/** One voucher line, already routed. Amounts in integer cents. */
export interface PreparedLine {
  lineNo: number;
  dim1: string; // GL account (AIT1)
  dim2?: string;
  dim3?: string;
  dim4?: string;
  dim5?: string;
  dim6?: string;
  dim7?: string;
  amountCents: number;
  taxCents?: number;
  vatCode?: string;
  description: string;
  receiptId?: string;
  routedBy?: string[];
  viaSuspense?: boolean;
}

/** A complete document ready to send, with the snapshot the audit trail keeps. */
export interface PreparedPosting {
  sessionId: string;
  userId: string;
  userName: string;
  userEmail: string;
  jobId?: string | null;
  jobNumber?: string | null;
  jobName?: string | null;
  groupName?: string | null;
  cono: string;
  divi: string;
  currency: string;
  accountingDate: string; // YYYY-MM-DD
  postingProfileKey: string;
  documentType: "ap_invoice" | "gl_journal";
  supplierNo?: string | null;
  lines: PreparedLine[];
}

export type PostingStatus =
  | "pending"
  | "posting"
  | "posted"
  | "rejected"
  | "unknown"
  | "blocked"
  | "reversed";

export type AttemptOutcome =
  // Written before the call; replaced by the real outcome afterwards.
  | "in_flight"
  | "posted"
  | "rejected"
  | "ambiguous"
  // PROVABLY never reached M3 - the TLS connection was never established, so
  // the grid cannot have acted. The name states the safety property because
  // this is the ONLY transport failure the queue is allowed to retry, and a
  // caller that reports a mere timeout here would cause a duplicate voucher.
  // M3Client only produces this when its `ambiguous` flag is false.
  | "not_delivered"
  // Token could not be obtained, so no request was dispatched at all.
  | "auth_error"
  | "blocked"
  | "reconciled_posted"
  | "reconciled_absent";

/** Outcomes after which the queue may safely try again. Nothing that could
 *  possibly have reached M3 belongs in this set. */
const RETRYABLE: ReadonlySet<AttemptOutcome> = new Set<AttemptOutcome>([
  "not_delivered",
  "auth_error",
  "reconciled_absent",
]);

export class PostingError extends Error {}

/**
 * Queue a session for posting, or return the existing queue row.
 *
 * Idempotent by construction: the reference is derived from the session id and
 * is unique, so a double approval, a retried webhook or two concurrent workers
 * all converge on one row. The `create` is allowed to lose the race and the
 * loser simply reads back the winner.
 */
export async function enqueuePosting(doc: PreparedPosting) {
  if (doc.lines.length === 0) {
    throw new PostingError("Refusing to enqueue a posting with no lines");
  }

  const reference = postingReference(doc.sessionId);
  const amountCents = doc.lines.reduce((sum, l) => sum + l.amountCents, 0);
  const taxCents = doc.lines.reduce((sum, l) => sum + (l.taxCents ?? 0), 0);

  const existing = await prisma.m3Posting.findUnique({ where: { sessionId: doc.sessionId } });
  if (existing) return existing;

  try {
    return await prisma.m3Posting.create({
      data: {
        sessionId: doc.sessionId,
        reference,
        status: "pending",
        userId: doc.userId,
        userName: doc.userName,
        userEmail: doc.userEmail,
        jobId: doc.jobId ?? null,
        jobNumber: doc.jobNumber ?? null,
        jobName: doc.jobName ?? null,
        groupName: doc.groupName ?? null,
        cono: doc.cono,
        divi: doc.divi,
        currency: doc.currency,
        amountCents,
        taxCents,
        accountingDate: doc.accountingDate,
        postingProfileKey: doc.postingProfileKey,
        documentType: doc.documentType,
        supplierNo: doc.supplierNo ?? null,
        lines: {
          create: doc.lines.map((l) => ({
            lineNo: l.lineNo,
            dim1: l.dim1,
            dim2: l.dim2 ?? null,
            dim3: l.dim3 ?? null,
            dim4: l.dim4 ?? null,
            dim5: l.dim5 ?? null,
            dim6: l.dim6 ?? null,
            dim7: l.dim7 ?? null,
            amountCents: l.amountCents,
            taxCents: l.taxCents ?? 0,
            vatCode: l.vatCode ?? null,
            description: l.description,
            receiptId: l.receiptId ?? null,
            routedBy: l.routedBy ? JSON.stringify(l.routedBy) : null,
            viaSuspense: l.viaSuspense ?? false,
          })),
        },
      },
    });
  } catch {
    // Lost the unique race - the other writer's row is the right one.
    const winner = await prisma.m3Posting.findUnique({ where: { sessionId: doc.sessionId } });
    if (!winner) throw new PostingError("Could not enqueue posting");
    return winner;
  }
}

/**
 * Claim the next posting due for sending, or null.
 *
 * `unknown` is pointedly absent from the claim filter. A posting whose outcome
 * we could not determine is never picked up again by the queue; it waits for
 * reconciliation, because re-sending it is precisely how a ledger acquires a
 * duplicate voucher.
 *
 * The claim is a conditional update, so two workers racing for the same row
 * produce one winner and one null rather than two sends.
 */
export async function claimNextPosting(now: Date = new Date()) {
  const candidate = await prisma.m3Posting.findFirst({
    where: {
      status: "pending",
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!candidate) return null;

  // Only succeeds if the row is still pending - the compare-and-swap that stops
  // two workers from both sending.
  // Minted per claim so the holder can prove ownership later. randomUUID
  // rather than a counter: a token must not be guessable or reconstructible by
  // a worker that lost its claim.
  const claimToken = randomUUID();

  const claimed = await prisma.m3Posting.updateMany({
    where: { id: candidate.id, status: "pending" },
    data: { status: "posting", claimedAt: now, claimToken },
  });
  if (claimed.count === 0) return null;

  const posting = await prisma.m3Posting.findUnique({
    where: { id: candidate.id },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  return posting ? { ...posting, claimToken } : null;
}

/** Status the posting lands in for a given attempt outcome. */
function statusForOutcome(outcome: AttemptOutcome, attempts: number, maxAttempts: number): PostingStatus {
  switch (outcome) {
    case "posted":
    case "reconciled_posted":
      return "posted";
    case "rejected":
      return "rejected";
    case "ambiguous":
      // The one-way door. Never returns to the queue on its own.
      return "unknown";
    case "blocked":
      return "blocked";
    case "not_delivered":
    case "auth_error":
    case "reconciled_absent":
      return attempts >= maxAttempts ? "blocked" : "pending";
    case "in_flight":
      // A still-running attempt must leave the posting claimed.
      return "posting";
  }
}

export interface AttemptStart {
  program?: string;
  transaction?: string;
  /** MI parameters as sent. Business data only - never credentials. */
  requestParams?: Record<string, string>;
  /** "system" for queue-driven attempts, else the userId that triggered it. */
  actor?: string;
  /** Statuses the posting may legitimately be in. Guards against a stale
   *  worker attempting against a posting somebody else has already settled. */
  allowedStatuses?: PostingStatus[];
  /**
   * The token returned by claimNextPosting. MANDATORY whenever "posting" is an
   * allowed status: checking the status alone would let two workers that each
   * believe they hold the claim both dispatch a voucher. Out-of-band attempts
   * (reconciliation) pass allowedStatuses without "posting" and need no token.
   */
  claimToken?: string;
}

export interface AttemptResult {
  outcome: Exclude<AttemptOutcome, "in_flight">;
  httpStatus?: number;
  m3Message?: string;
  voucherNo?: string;
  voucherSeries?: string;
  fiscalYear?: string;
}

/**
 * Open an attempt BEFORE calling M3.
 *
 * This ordering is the whole point. Writing the attempt after the call means a
 * process that dies mid-send leaves a posting with no record of what was tried
 * - the one situation where the audit trail is most needed and least able to
 * help. An attempt left `in_flight` is not a gap: it is positive evidence that
 * a send began and never reported back, and recoverStalePostings treats it with
 * the same suspicion as an explicit timeout.
 *
 * The attempt number comes from an atomic increment, so two workers cannot
 * compute the same one and have the loser's genuine attempt vanish on a unique
 * constraint.
 */
export async function beginAttempt(postingId: string, start: AttemptStart = {}) {
  const allowed = start.allowedStatuses ?? ["posting"];

  return prisma.$transaction(async (tx) => {
    const needToken = allowed.includes("posting");
    if (needToken && !start.claimToken) {
      throw new PostingError(`Posting ${postingId} requires a claim token to dispatch`);
    }

    // The status check, the token check and the attempt-number increment are a
    // SINGLE conditional update. Reading first and updating second left a
    // window in which recoverStalePostings could revoke the claim between the
    // two, and the stale worker would still go on to dispatch.
    const guarded = await tx.m3Posting.updateMany({
      where: {
        id: postingId,
        status: { in: allowed },
        ...(needToken ? { claimToken: start.claimToken } : {}),
      },
      data: { attempts: { increment: 1 } },
    });

    if (guarded.count === 0) {
      const current = await tx.m3Posting.findUnique({
        where: { id: postingId },
        select: { status: true },
      });
      if (!current) throw new PostingError(`Posting ${postingId} not found`);
      throw new PostingError(
        `Posting ${postingId} is ${current.status} or its claim was revoked; refusing to dispatch`,
      );
    }

    const bumped = await tx.m3Posting.findUnique({
      where: { id: postingId },
      select: { attempts: true },
    });
    if (!bumped) throw new PostingError(`Posting ${postingId} not found`);

    const attempt = await tx.m3PostingAttempt.create({
      data: {
        postingId,
        attemptNo: bumped.attempts,
        outcome: "in_flight",
        program: start.program ?? null,
        transaction: start.transaction ?? null,
        requestParams: start.requestParams ? JSON.stringify(start.requestParams) : null,
        actor: start.actor ?? "system",
        ambiguous: false,
      },
    });

    return { attemptId: attempt.id, attemptNo: attempt.attemptNo, startedAt: attempt.startedAt };
  });
}

/**
 * Close an open attempt with its outcome and move the posting to its new state.
 *
 * Both happen in one transaction, and the posting update is a compare-and-swap
 * on the status we expect: a slow worker returning after the row has already
 * been settled by someone else must not be able to drag a `posted` posting back
 * to `pending` and license a second send.
 */
export async function completeAttempt(
  attemptId: string,
  result: AttemptResult,
  {
    maxAttempts = 5,
    backoffMs = 60_000,
    expectStatuses = ["posting"] as PostingStatus[],
  }: { maxAttempts?: number; backoffMs?: number; expectStatuses?: PostingStatus[] } = {},
) {
  return prisma.$transaction(async (tx) => {
    const attempt = await tx.m3PostingAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt) throw new PostingError(`Attempt ${attemptId} not found`);

    const posting = await tx.m3Posting.findUnique({ where: { id: attempt.postingId } });
    if (!posting) throw new PostingError(`Posting ${attempt.postingId} not found`);

    // Recovery closed this attempt while the call was still running. Throwing
    // here would discard the answer we finally got - which is often the most
    // valuable record in the whole trail, because a late "posted, voucher
    // 12345" is exactly what resolves the unknown that expiring the lease
    // created. Record it as a new attempt instead of rewriting the closed one.
    if (attempt.outcome !== "in_flight") {
      const bumped = await tx.m3Posting.update({
        where: { id: posting.id },
        data: { attempts: { increment: 1 } },
        select: { attempts: true },
      });

      await tx.m3PostingAttempt.create({
        data: {
          postingId: posting.id,
          attemptNo: bumped.attempts,
          outcome: result.outcome,
          program: attempt.program,
          transaction: attempt.transaction,
          requestParams: attempt.requestParams,
          httpStatus: result.httpStatus ?? null,
          m3Message: `[late report; lease had expired] ${result.m3Message ?? ""}`.trim(),
          voucherNo: result.voucherNo ?? null,
          ambiguous: result.outcome === "ambiguous",
          actor: attempt.actor,
          startedAt: attempt.startedAt,
          finishedAt: new Date(),
          durationMs: Date.now() - attempt.startedAt.getTime(),
        },
      });

      // A late confirmation is allowed to resolve an unknown - and only that.
      // It must never move a posting that somebody has since settled.
      if (result.outcome === "posted") {
        const resolved = await tx.m3Posting.updateMany({
          where: { id: posting.id, status: "unknown" },
          data: {
            status: "posted",
            postedAt: posting.postedAt ?? new Date(),
            voucherNo: result.voucherNo ?? posting.voucherNo,
            voucherSeries: result.voucherSeries ?? posting.voucherSeries,
            fiscalYear: result.fiscalYear ?? posting.fiscalYear,
            lastError: null,
          },
        });
        if (resolved.count > 0) {
          return { settled: true, status: "posted" as PostingStatus, attemptNo: bumped.attempts, late: true };
        }
        // Somebody settled it while we were away - report where it really is,
        // not where our late news would have put it.
        const current = await tx.m3Posting.findUnique({
          where: { id: posting.id },
          select: { status: true },
        });
        return {
          settled: false,
          status: (current?.status ?? posting.status) as PostingStatus,
          attemptNo: bumped.attempts,
          late: true,
        };
      }

      return { settled: false, status: posting.status as PostingStatus, attemptNo: bumped.attempts, late: true };
    }

    const ambiguous = result.outcome === "ambiguous";
    const status = statusForOutcome(result.outcome, attempt.attemptNo, maxAttempts);
    const posted = status === "posted";

    // CAS the posting FIRST. If we lost it, the attempt is still recorded, but
    // annotated as not having settled anything - writing the outcome first
    // would leave a definitive-looking result that never governed the posting.
    const moved = await tx.m3Posting.updateMany({
      where: { id: posting.id, status: { in: expectStatuses } },
      data: {
        status,
        claimedAt: null,
        claimToken: null,
        lastError: result.m3Message ?? null,
        // Only a genuinely retryable outcome earns a next attempt time.
        // Anything else leaves it null, so a later change to the claim filter
        // cannot accidentally resurrect a posting that may have committed.
        nextAttemptAt:
          status === "pending" && RETRYABLE.has(result.outcome)
            ? new Date(Date.now() + backoffMs * 2 ** (attempt.attemptNo - 1))
            : null,
        postedAt: posted ? (posting.postedAt ?? new Date()) : posting.postedAt,
        voucherNo: result.voucherNo ?? posting.voucherNo,
        voucherSeries: result.voucherSeries ?? posting.voucherSeries,
        fiscalYear: result.fiscalYear ?? posting.fiscalYear,
      },
    });

    const settled = moved.count > 0;

    await tx.m3PostingAttempt.update({
      where: { id: attemptId },
      data: {
        outcome: result.outcome,
        httpStatus: result.httpStatus ?? null,
        m3Message: settled
          ? (result.m3Message ?? null)
          : `[did not settle: posting was already ${posting.status}] ${result.m3Message ?? ""}`.trim(),
        voucherNo: result.voucherNo ?? null,
        ambiguous,
        durationMs: Date.now() - attempt.startedAt.getTime(),
        finishedAt: new Date(),
      },
    });

    // The attempt record stands either way - losing the CAS is itself worth
    // knowing about, and discarding it would put a hole in the history.
    return { settled, status, attemptNo: attempt.attemptNo, late: false };
  });
}

/**
 * Rescue postings whose worker died mid-send.
 *
 * They move to `unknown`, never back to `pending`. A process that vanished
 * after dispatch is indistinguishable from one that posted successfully and
 * never got to say so, and guessing in the optimistic direction is how a ledger
 * acquires duplicate vouchers.
 */
export async function recoverStalePostings(leaseMs = 5 * 60_000, now: Date = new Date()) {
  const cutoff = new Date(now.getTime() - leaseMs);

  const stale = await prisma.m3Posting.findMany({
    where: { status: "posting", claimedAt: { lt: cutoff } },
    select: { id: true },
  });
  if (stale.length === 0) return { recovered: 0 };

  let recovered = 0;
  for (const { id } of stale) {
    await prisma.$transaction(async (tx) => {
      const moved = await tx.m3Posting.updateMany({
        where: { id, status: "posting", claimedAt: { lt: cutoff } },
        data: {
          status: "unknown",
          claimedAt: null,
          // Revoking the token fences off the stalled worker: if it wakes and
          // tries to open another attempt, beginAttempt refuses it.
          claimToken: null,
          nextAttemptAt: null,
          lastError: "Worker did not report an outcome; lease expired.",
        },
      });
      if (moved.count === 0) return;
      recovered++;

      // Close any attempt still marked in_flight, so the trail says what
      // happened rather than trailing off.
      await tx.m3PostingAttempt.updateMany({
        where: { postingId: id, outcome: "in_flight" },
        data: {
          outcome: "ambiguous",
          ambiguous: true,
          m3Message: "Worker died before reporting an outcome.",
          finishedAt: new Date(),
        },
      });
    });
  }

  return { recovered };
}

/**
 * Postings needing a human or a reconciler to look at M3.
 *
 * This is the queue that must never grow unattended: every row is a voucher
 * that may or may not exist in the ledger.
 */
export async function unknownPostings() {
  return prisma.m3Posting.findMany({
    where: { status: "unknown" },
    orderBy: { updatedAt: "asc" },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
}
