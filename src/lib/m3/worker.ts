// Drives the posting queue: claim -> open attempt -> call M3 -> close attempt.
//
// The ordering here is the safety property, not an implementation detail. The
// attempt is opened BEFORE the call and the outcome written after, so a process
// that dies mid-send leaves an `in_flight` attempt that recoverStalePostings
// can find. Nothing in this file may reorder those steps.

import { M3Client, type MIResult } from "./client";
import {
  claimNextPosting,
  beginAttempt,
  completeAttempt,
  recoverStalePostings,
  type AttemptResult,
} from "./posting";

/** A posting as handed to the poster: the queue row plus its resolved lines. */
export type ClaimedPosting = NonNullable<Awaited<ReturnType<typeof claimNextPosting>>>;

/**
 * How a voucher is actually created in M3.
 *
 * Deliberately an interface. The MI program and transaction that accept a
 * voucher, and whether a custom deduplicating transaction is available, are
 * installation-specific and still open questions for the M3 team - see
 * docs/M3_ION_INTEGRATION.md. Guessing them here would bake a wrong answer
 * into the one code path that must not be wrong.
 */
export interface VoucherPoster {
  program: string;
  transaction: string;
  /** MI parameters for this posting, including the external reference. */
  buildParams(posting: ClaimedPosting): Record<string, string>;
  /** Pull the voucher identifiers out of a successful response. */
  readVoucher(result: Extract<MIResult, { ok: true }>): {
    voucherNo?: string;
    voucherSeries?: string;
    fiscalYear?: string;
  };
}

/**
 * Map a client result onto a queue outcome.
 *
 * Total over the client's closed `reason` set, on purpose: an unmapped case
 * would fall through to a default, and the only safe default here is
 * "ambiguous", which is expensive. Making the compiler prove exhaustiveness is
 * cheaper than discovering a gap during a month-end close.
 */
export function outcomeFor(result: MIResult, poster: VoucherPoster): AttemptResult {
  if (result.ok) {
    const voucher = poster.readVoucher(result);
    return { outcome: "posted", ...voucher };
  }

  // The client sets `ambiguous` only when it genuinely cannot tell whether M3
  // acted. It dominates every other consideration.
  if (result.ambiguous) {
    return { outcome: "ambiguous", httpStatus: result.status, m3Message: result.message };
  }

  const base = { httpStatus: result.status, m3Message: result.message };
  switch (result.reason) {
    case "auth":
      return { outcome: "auth_error", ...base };
    case "not_delivered":
      return { outcome: "not_delivered", ...base };
    case "rejected":
      return { outcome: "rejected", ...base };
    case "invalid_request":
      // Our own bug or bad configuration - retrying changes nothing.
      return { outcome: "blocked", ...base };
    case "http_error":
      // Not ambiguous, so this was a read or a definitively-rejected write.
      return { outcome: "rejected", ...base };
    case "unknown_delivery":
      // Should have been caught by `ambiguous` above; treat as unknown anyway.
      return { outcome: "ambiguous", ...base };
  }
}

/**
 * Post one queued voucher, or return null when the queue is empty.
 *
 * Never throws for an M3-side failure: those are outcomes, and an outcome that
 * escaped as an exception would leave an attempt open and a posting claimed.
 */
export async function postNext(client: M3Client, poster: VoucherPoster) {
  const posting = await claimNextPosting();
  if (!posting) return null;

  const params = poster.buildParams(posting);

  // Opened before the call. If the process dies after this line, the trail
  // still shows what was attempted.
  const { attemptId } = await beginAttempt(posting.id, {
    program: poster.program,
    transaction: poster.transaction,
    requestParams: params,
    claimToken: posting.claimToken,
  });

  let result: AttemptResult;
  try {
    const mi = await client.execute(poster.program, poster.transaction, params, { write: true });
    result = outcomeFor(mi, poster);
  } catch (e: unknown) {
    // An unexpected throw tells us nothing about whether M3 acted, so it is
    // treated exactly like a timeout: unknown, never retried.
    result = {
      outcome: "ambiguous",
      m3Message: `Unexpected error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const settled = await completeAttempt(attemptId, result);
  return { posting, result, settled };
}

/**
 * Drain the queue.
 *
 * Sequential by design. Postings are independent, but concurrency here buys
 * little and costs a great deal: parallel writers make the grid's own locking
 * the bottleneck and turn one bad configuration into many ambiguous postings
 * at once, each needing manual reconciliation.
 */
export async function drainPostingQueue(
  client: M3Client,
  poster: VoucherPoster,
  { max = 50, leaseMs = 5 * 60_000 }: { max?: number; leaseMs?: number } = {},
) {
  // Reclaim anything a dead worker left behind before taking new work, so a
  // stuck posting surfaces as `unknown` promptly rather than after the next
  // deploy.
  const { recovered } = await recoverStalePostings(leaseMs);

  let processed = 0;
  const outcomes: Record<string, number> = {};

  while (processed < max) {
    const done = await postNext(client, poster);
    if (!done) break;
    processed++;
    outcomes[done.result.outcome] = (outcomes[done.result.outcome] ?? 0) + 1;

    // An ambiguous posting means we no longer know the ledger's state. Stop:
    // whatever caused it is likely to affect the next posting too, and turning
    // one reconciliation into fifty helps nobody.
    if (done.result.outcome === "ambiguous") break;
  }

  return { recovered, processed, outcomes };
}
