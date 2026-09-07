// What is worth a second look on a freshly captured receipt.
//
// The review screen's whole value is that it flags a MINORITY. A screen that
// puts a warning on every row is one a technician learns to swipe past, and
// then the one receipt that really was misread goes through with everything
// else. So a rule earns its place here only if it fires on something that is
// definitely wrong, definitely missing, or definitely not yet sent.
//
// Note what is deliberately NOT here.
//
//  - The design's example copy is "Total was blurry — check it", which implies
//    an OCR confidence score. No provider reports one, so claiming blurriness
//    would be a guess dressed as a measurement.
//  - "The line items come to more than the total" was written and then removed.
//    `providers/ocr.ts` discards line items with a non-positive amount, so a
//    coupon or a discount is dropped while the goods remain - and the goods
//    then legitimately exceed the total. The check could not tell that apart
//    from a misread total.
//  - `subtotal + tax === total` is not checked when the total EQUALS the
//    subtotal, because `providers/pdf.ts` documents that shape as a real one:
//    a VAT-inclusive invoice, where the total is a tax-inclusive subtotal.
//
// Everything is keyed on the ROW - the position in the burst, the way the
// capture strip and this screen both number the photographs - rather than on
// the receipts alone. A capture still sitting in the offline queue has no
// receipt, and it still occupies a row that has to be counted and named.

import type { ReceiptDTO } from "./dto";
import type { CaptureShot } from "./capture";

export type ConcernCode =
  | "not-sent"
  | "sending"
  | "unread"
  | "no-total"
  | "does-not-add-up"
  | "identical-to-earlier"
  | "no-merchant"
  | "still-reading";

export interface Concern {
  code: ConcernCode;
  /** What the technician is shown. Plain speech, no jargon, no scores. */
  message: string;
  /**
   * `check` needs a person; `waiting` is the app still working.
   *
   * They look different on screen and count differently in the summary: a
   * receipt still being read is not a problem, and telling someone to check
   * something that has not finished arriving wastes the one warning they will
   * actually read.
   */
  severity: "check" | "waiting";
}

/** One row of the review screen: a photograph, and the receipt it became. */
export interface BurstEntry {
  shot: CaptureShot;
  /** Null while the upload is queued, in flight, or was refused. */
  receipt: ReceiptDTO | null;
}

/** The burst, in capture order. Row N is `entries[N - 1]`. */
export interface BurstContext {
  entries: BurstEntry[];
}

/**
 * Everything doubtful about one row, most important first.
 *
 * Ordered rather than reduced to a single flag so the screen can show the one
 * that matters while the rest stay available; the caller renders the head.
 */
export function entryConcerns(entry: BurstEntry, context: BurstContext): Concern[] {
  if (!entry.receipt) {
    // No receipt yet. Which of these it is decides whether the technician has
    // anything to do, so they are not collapsed into one message.
    if (entry.shot.status === "failed") {
      return [
        {
          code: "not-sent",
          message: entry.shot.message ?? "Didn't send — take it again",
          severity: "check",
        },
      ];
    }
    return [
      {
        code: "sending",
        message:
          entry.shot.status === "queued"
            ? (entry.shot.message ?? "Saved — sends when you get signal")
            : "Sending…",
        severity: "waiting",
      },
    ];
  }

  const receipt = entry.receipt;

  // Already confirmed by a person. Their judgement outranks these rules - they
  // had the paper in their hand, and re-flagging it after they said it was
  // right is how a screen teaches people to ignore it.
  if (receipt.status === "verified") return [];

  if (receipt.status === "pending") {
    return [{ code: "still-reading", message: "Still reading this one…", severity: "waiting" }];
  }

  if (receipt.status === "failed") {
    return [{ code: "unread", message: "Couldn't read this one — type it in", severity: "check" }];
  }

  const concerns: Concern[] = [];

  if (receipt.total === null) {
    concerns.push({ code: "no-total", message: "No total read — add it", severity: "check" });
  } else {
    // Only checkable when all three figures are there, and only when the total
    // is not simply the subtotal - see the note at the top of this file about
    // tax-inclusive invoices.
    if (
      receipt.subtotal !== null &&
      receipt.tax !== null &&
      receipt.total !== receipt.subtotal &&
      receipt.subtotal + receipt.tax !== receipt.total
    ) {
      concerns.push({
        code: "does-not-add-up",
        message: "The figures don't add up — check the total",
        severity: "check",
      });
    }

    const earlier = earlierIdenticalRow(entry, context);
    if (earlier !== null) {
      concerns.push({
        code: "identical-to-earlier",
        message: `Everything on this matches photo ${earlier} — the same receipt twice?`,
        severity: "check",
      });
    }
  }

  // Last, and only when the money is otherwise sound: a missing shop name is a
  // nuisance rather than a fault, and it must not be the warning that crowds
  // out a total that does not add up.
  if (!receipt.merchant?.trim() && concerns.length === 0) {
    concerns.push({ code: "no-merchant", message: "No shop name read", severity: "check" });
  }

  return concerns;
}

/**
 * The row number of an earlier photograph that read out identically, or null.
 *
 * This is the one rule here that asks a question rather than stating a fault,
 * and it is worded as a question for that reason. Auto-capture's characteristic
 * mistake is firing twice over one receipt, and a receipt counted twice inflates
 * a job's costs silently - nobody finds it until someone reconciles the ledger.
 *
 * It cannot be PROVED from a read: two identical purchases in one shop would
 * look the same. So the bar is that everything read off the two is identical -
 * shop, total, date, payment and every line - not merely the shop and the
 * total, which two coffees at the same price would also match. The message says
 * only what is true: that the two reads are the same.
 */
function earlierIdenticalRow(entry: BurstEntry, context: BurstContext): number | null {
  const receipt = entry.receipt;
  if (!receipt || receipt.total === null || receipt.total === 0) return null;
  // An unread shop name is the commonest field to miss; two nameless receipts
  // matching each other is not evidence of anything.
  if (!receipt.merchant?.trim()) return null;

  const here = rowOf(context, receipt.id);
  const fingerprint = readFingerprint(receipt);
  for (let i = 0; i < context.entries.length; i++) {
    // Only rows BEFORE this one, so a pair puts a warning on the second and
    // leaves the first looking like what it is - the original.
    if (i + 1 >= here) break;
    const other = context.entries[i].receipt;
    if (!other || other.id === receipt.id) continue;
    if (readFingerprint(other) === fingerprint) return i + 1;
  }
  return null;
}

/**
 * Everything known about a receipt, as one comparable string.
 *
 * Every field a reader or a person can fill in is here, because the message on
 * screen says "everything on this matches" and that has to be true. What is
 * deliberately left out is the photograph itself - `imagePath` and `captureId`
 * differ between two pictures of one receipt, which is the very case this is
 * looking for - and `status`, which moves on its own as a receipt is processed.
 */
function readFingerprint(r: ReceiptDTO): string {
  return JSON.stringify([
    normalise(r.merchant),
    r.total,
    r.subtotal,
    r.tax,
    // The date only, never the instant: two reads of one receipt agree on the
    // date, and the time of day is not on the paper.
    r.purchaseDate ? r.purchaseDate.slice(0, 10) : null,
    normalise(r.paymentRaw),
    normalise(r.paymentLabel),
    r.country,
    r.region,
    r.taxes.map((t) => [t.code, t.ratePpm, t.amount]),
    r.lineItems.map((li) => [normalise(li.description), li.quantity, li.amount]),
  ]);
}

function normalise(value: string | null): string | null {
  const trimmed = value?.trim().replace(/\s+/g, " ").toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * Which row a receipt occupies, 1-based.
 *
 * By id rather than by object identity: a context rebuilt from a server refresh
 * holds equal-but-different objects, and an identity comparison silently
 * stopped matching the moment that happened. A receipt the context does not
 * mention is treated as coming last, so it is compared against everything
 * rather than against nothing.
 */
function rowOf(context: BurstContext, receiptId: string): number {
  const at = context.entries.findIndex((e) => e.receipt?.id === receiptId);
  return at === -1 ? context.entries.length + 1 : at + 1;
}

/** Nothing to check, and nothing still arriving. */
export function looksFine(entry: BurstEntry, context: BurstContext): boolean {
  return entryConcerns(entry, context).length === 0;
}

export interface ReviewSummary {
  /** Rows with nothing wrong with them. */
  fine: number;
  /** Rows a person needs to look at. */
  needsCheck: number;
  /** Rows the app has not finished with - reading, sending, or queued. */
  waiting: number;
  /**
   * The burst's money.
   *
   * Only what has actually been read. A photograph still in the queue and a
   * receipt with no total both contribute nothing rather than being guessed at,
   * which is why the two counts below exist: they say which way the figure is
   * wrong.
   */
  totalCents: number;
  /**
   * Rows contributing no money yet - no total read, or no receipt at all.
   *
   * These make the figure too SMALL, and the screen says so in those words.
   */
  missingTotals: number;
  /**
   * Rows that read identically to an earlier one.
   *
   * The counterpart: these may make the figure too LARGE.
   */
  duplicates: number;
}

export function summariseBurst(entries: BurstEntry[]): ReviewSummary {
  const context: BurstContext = { entries };
  let fine = 0;
  let needsCheck = 0;
  let waiting = 0;
  let totalCents = 0;
  let missingTotals = 0;
  let duplicates = 0;

  for (const entry of entries) {
    const total = entry.receipt?.total ?? null;
    totalCents += total ?? 0;
    if (total === null) missingTotals++;

    const concerns = entryConcerns(entry, context);
    if (concerns.some((c) => c.code === "identical-to-earlier")) duplicates++;
    if (concerns.length === 0) fine++;
    else if (concerns.some((c) => c.severity === "check")) needsCheck++;
    else waiting++;
  }

  return { fine, needsCheck, waiting, totalCents, missingTotals, duplicates };
}
