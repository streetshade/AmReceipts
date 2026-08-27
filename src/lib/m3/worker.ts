// Drives the posting queue: claim -> step through the MI sequence -> settle.
//
// Two orderings in here are safety properties rather than implementation
// details, and neither may be rearranged:
//
//   1. Each attempt is opened BEFORE its call and closed after, so a process
//      that dies mid-send leaves an `in_flight` attempt for recovery to find.
//   2. Only the committing step may settle the posting as `posted`. The header
//      and line calls stage a batch; reporting success before the confirm would
//      claim a voucher that does not exist.

import { M3Client, type MIResult } from "./client";
import {
  claimNextPosting,
  beginAttempt,
  completeAttempt,
  recoverStalePostings,
  type AttemptResult,
} from "./posting";
import {
  buildSteps,
  applyBatchId,
  VoucherBuildError,
  type VoucherPosterConfig,
  type PostingStep,
  type PostingDocument,
} from "./voucherPoster";

/** A posting as handed back by the queue: the row plus its resolved lines. */
export type ClaimedPosting = NonNullable<Awaited<ReturnType<typeof claimNextPosting>>>;

/** Read one named field out of the first record of a successful MI response. */
function readField(result: Extract<MIResult, { ok: true }>, field: string | undefined): string | undefined {
  if (!field) return undefined;
  const value = result.records[0]?.[field];
  return value === "" ? undefined : value;
}

/**
 * Map a client result onto a queue outcome.
 *
 * Total over the client's closed `reason` set on purpose: an unmapped case
 * would need a default, and the only safe default here is "ambiguous", which
 * costs a manual reconciliation. Letting the compiler prove exhaustiveness is
 * cheaper than finding the gap during a month-end close.
 */
export function outcomeFor(result: MIResult, step: PostingStep): AttemptResult {
  if (result.ok) return { outcome: "posted" };

  // `ambiguous` is set by the client only when it genuinely cannot tell whether
  // M3 acted. It dominates everything else.
  if (result.ambiguous) {
    return {
      outcome: "ambiguous",
      httpStatus: result.status,
      // What to go looking for differs sharply by step, and the person
      // reconciling needs to know which they are facing.
      m3Message: step.commits
        ? `Outcome unknown on the committing ${step.kind} call: a voucher MAY exist. ${result.message}`
        : `Outcome unknown on the ${step.kind} call (pre-commit): no voucher, but an unconfirmed batch may be left in M3. ${result.message}`,
    };
  }

  const base = { httpStatus: result.status, m3Message: `${step.kind}: ${result.message}` };
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
      return { outcome: "rejected", ...base };
    case "unknown_delivery":
      // Should have been caught by `ambiguous`; treat as unknown regardless.
      return { outcome: "ambiguous", ...base };
  }
}

function toDocument(posting: ClaimedPosting): PostingDocument {
  return {
    reference: posting.reference,
    cono: posting.cono,
    divi: posting.divi,
    currency: posting.currency,
    accountingDate: posting.accountingDate,
    supplierNo: posting.supplierNo,
    amountCents: posting.amountCents,
    postingProfileKey: posting.postingProfileKey,
    lines: posting.lines.map((l) => ({
      lineNo: l.lineNo,
      dim1: l.dim1,
      dim2: l.dim2,
      dim3: l.dim3,
      dim4: l.dim4,
      dim5: l.dim5,
      dim6: l.dim6,
      dim7: l.dim7,
      amountCents: l.amountCents,
      vatCode: l.vatCode,
      description: l.description,
    })),
  };
}

export interface PostOutcome {
  posting: ClaimedPosting;
  outcome: AttemptResult["outcome"];
  message?: string;
  stepsRun: number;
}

/**
 * Post one queued voucher, or null when the queue is empty.
 *
 * Never throws for an M3-side failure: those are outcomes, and an exception
 * escaping here would leave an attempt open and a posting claimed.
 */
export async function postNext(
  client: M3Client,
  config: VoucherPosterConfig,
): Promise<PostOutcome | null> {
  const posting = await claimNextPosting();
  if (!posting) return null;

  let steps: PostingStep[];
  try {
    steps = buildSteps(config, toDocument(posting));
  } catch (e: unknown) {
    // Nothing has been dispatched, so this is a clean, unambiguous block.
    const message = e instanceof VoucherBuildError ? e.message : String(e);
    const { attemptId } = await beginAttempt(posting.id, { claimToken: posting.claimToken });
    await completeAttempt(attemptId, { outcome: "blocked", m3Message: message });
    return { posting, outcome: "blocked", message, stepsRun: 0 };
  }
  let stepsRun = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const isLast = i === steps.length - 1;

    let attemptId: string;
    try {
      attemptId = (
        await beginAttempt(posting.id, {
          program: step.program,
          transaction: step.transaction,
          requestParams: step.params,
          claimToken: posting.claimToken,
          commits: step.commits,
        })
      ).attemptId;
    } catch (e: unknown) {
      // The claim was revoked (lease expired) or the posting was settled by
      // someone else. Stop: dispatching now would race whoever owns it.
      return {
        posting,
        outcome: "blocked",
        message: `Could not open attempt: ${e instanceof Error ? e.message : String(e)}`,
        stepsRun,
      };
    }

    let result: AttemptResult;
    let mi: MIResult | null = null;
    try {
      mi = await client.execute(step.program, step.transaction, step.params, { write: true });
      result = outcomeFor(mi, step);
    } catch (e: unknown) {
      // An unexpected throw tells us nothing about whether M3 acted, so it is
      // treated exactly like a timeout: unknown, never retried.
      result = {
        outcome: "ambiguous",
        m3Message: `Unexpected error on ${step.kind}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // The committing step is the only one allowed to report a voucher.
    if (result.outcome === "posted" && mi?.ok && step.commits) {
      // The committing step's OWN response mapping. When there is no confirm
      // call, the last LINE commits, and reading head.response there would look
      // for the voucher in the wrong place.
      const response =
        step.kind === "confirm"
          ? config.confirm?.response
          : step.kind === "line"
            ? config.line.response
            : config.head.response;
      result.voucherNo = readField(mi, response?.voucherNo);
      result.voucherSeries = readField(mi, response?.voucherSeries);
      result.fiscalYear = readField(mi, response?.fiscalYear);
    }

    await completeAttempt(attemptId, result, { settle: isLast || result.outcome !== "posted" });
    stepsRun++;

    if (result.outcome !== "posted") {
      return { posting, outcome: result.outcome, message: result.m3Message, stepsRun };
    }

    // Thread the batch id from the header into the calls that follow it.
    if (step.kind === "head" && mi?.ok) {
      const batchId = readField(mi, config.head.response?.batchId);
      if (batchId) applyBatchId(config, steps, batchId);
    }
  }

  return { posting, outcome: "posted", stepsRun };
}

/**
 * Drain the queue.
 *
 * Sequential by design. Postings are independent, but concurrency buys little
 * and costs a lot: parallel writers make the grid's own locking the bottleneck
 * and turn one bad configuration into many ambiguous postings at once, each
 * needing manual reconciliation.
 */
export async function drainPostingQueue(
  client: M3Client,
  config: VoucherPosterConfig,
  { max = 50, leaseMs = 5 * 60_000 }: { max?: number; leaseMs?: number } = {},
) {
  // Reclaim anything a dead worker left behind before taking new work, so a
  // stuck posting surfaces as `unknown` promptly rather than after a redeploy.
  const { recovered } = await recoverStalePostings(leaseMs);

  let processed = 0;
  let stoppedEarly: string | null = null;
  const outcomes: Record<string, number> = {};

  while (processed < max) {
    const done = await postNext(client, config);
    if (!done) break;
    processed++;
    outcomes[done.outcome] = (outcomes[done.outcome] ?? 0) + 1;

    // An ambiguous posting means we no longer know the ledger's state, and an
    // auth failure means none of the rest will fare better. Stop either way:
    // turning one reconciliation into fifty helps nobody.
    if (done.outcome === "ambiguous" || done.outcome === "auth_error") {
      stoppedEarly = done.outcome;
      break;
    }
  }

  return { recovered, processed, outcomes, stoppedEarly };
}
