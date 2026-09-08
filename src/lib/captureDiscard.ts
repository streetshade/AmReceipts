"use client";

// Throwing away a bad photograph.
//
// Auto-capture guarantees bad photographs: it fires on a steady hand, so it
// catches thumbs, table tops, the same receipt twice and the occasional blur.
// A burst you cannot delete from is therefore not finished - the review screen
// flags a duplicate and then offers no way to be rid of it, and the visit total
// stays wrong.
//
// What "delete" means depends on how far the photograph got, and getting that
// wrong is expensive in both directions: deleting only the local tile leaves a
// receipt on the visit that nobody can see to remove, and deleting the receipt
// while the photograph is still in the upload queue leaves the queue to send it
// again a minute later.

import { remove as removeQueued } from "./offlineQueue";

export type DiscardPlan =
  /** It became a receipt. */
  | { kind: "server"; receiptId: string }
  /** Still in the offline queue, so it exists only on this phone... */
  | { kind: "queued" }
  /** ...or nowhere at all: refused, or the photograph itself failed. */
  | { kind: "local" }
  /** In flight. The upload cannot be called back, so the server is told. */
  | { kind: "inflight" };

export function planDiscard(input: {
  receiptId: string | null;
  /** The capture's own status, as the camera screen last saw it. */
  status: "uploading" | "read" | "queued" | "failed";
  /** Whether the upload queue still holds it. Null when the queue is unreadable. */
  queued: boolean | null;
}): DiscardPlan {
  if (input.receiptId) return { kind: "server", receiptId: input.receiptId };
  if (input.queued) return { kind: "queued" };
  if (input.status === "failed") return { kind: "local" };
  return { kind: "inflight" };
}

export interface DiscardResult {
  ok: boolean;
  /** Set when the server refused; shown to the user rather than swallowed. */
  error?: string;
}

/**
 * Throw a photograph away, everywhere it might exist.
 *
 * The plan above says where it is RIGHT NOW, but that is not where it will be a
 * second from now: an upload in the air will create a receipt, and a queued
 * blob will be sent by the next flush. Neither request can be recalled.
 *
 * So every case that is not purely local goes to the server, addressed by
 * CAPTURE id rather than receipt id. That call deletes the receipt if there is
 * one and records the capture as discarded, after which the upload route
 * refuses anything arriving under that id. It is the only way "deleted" can
 * mean deleted while requests are still in flight.
 *
 * The local queue is cleared too, first and best-effort. Failing to clear it is
 * no longer dangerous - the server would refuse the upload anyway - it just
 * means the phone wastes one request finding that out.
 */
export async function discardCapture(
  sessionId: string,
  captureId: string,
  plan: DiscardPlan,
): Promise<DiscardResult> {
  try {
    await removeQueued(captureId);
  } catch {
    // An unreadable queue is not a reason to leave the receipt in place, and
    // the server-side tombstone covers what this would have prevented.
  }

  // Nothing ever left the phone, and nothing is on its way.
  if (plan.kind === "local") return { ok: true };

  try {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/captures/${encodeURIComponent(captureId)}`,
      { method: "DELETE" },
    );
    // A visit that no longer exists took its receipts with it.
    if (res.ok || res.status === 404) return { ok: true };
    return { ok: false, error: "Couldn't delete that one. Try again in a moment." };
  } catch {
    return {
      ok: false,
      error: "No connection — it can't be deleted until you have signal.",
    };
  }
}
