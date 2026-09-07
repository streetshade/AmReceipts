// Checks for the review screen's judgement.
//
//   npm run check:review
//
// The property that matters is RESTRAINT. A screen that warns about everything
// is one a technician learns to swipe past, and then the receipt that really
// was misread goes through with the rest. So most of these assertions are that
// an ordinary receipt gets NO warning - which is the harder half to get right,
// and the half a demo never exercises.
//
// The other half is that nothing can disappear. A photograph still in the
// offline queue has no receipt, and the counts, the totals and the footer
// wording all have to keep accounting for it.

import {
  entryConcerns,
  looksFine,
  summariseBurst,
  type BurstEntry,
  type ConcernCode,
} from "../src/lib/receiptQuality";
import type { ReceiptDTO } from "../src/lib/dto";
import type { CaptureShot } from "../src/lib/capture";

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "  ok  " : "  FAIL"} ${name}${detail && !passed ? ` — ${detail}` : ""}`);
  if (!passed) failures++;
}

let seq = 0;
function receipt(over: Partial<ReceiptDTO> = {}): ReceiptDTO {
  const n = ++seq;
  return {
    id: `r${n}`,
    captureId: `c${n}`,
    imagePath: "/uploads/x.jpg",
    merchant: "Home Hardware",
    purchaseDate: "2026-09-02T00:00:00.000Z",
    subtotal: 1000,
    tax: 130,
    total: 1130,
    paymentRaw: "VISA ****1234",
    paymentLabel: "VISA ••1234",
    status: "processed",
    country: "CA",
    region: "ON",
    taxes: [],
    lineItems: [],
    ...over,
  };
}

function shot(over: Partial<CaptureShot> = {}): CaptureShot {
  return { id: `s${++seq}`, preview: "data:,", status: "read", totalCents: null, merchant: null, ...over };
}

/** A row that produced a receipt. */
const row = (r: ReceiptDTO): BurstEntry => ({ shot: shot({ id: r.captureId ?? r.id }), receipt: r });
/** A row whose photograph has not become a receipt. */
const bare = (status: CaptureShot["status"], message?: string): BurstEntry => ({
  shot: shot({ status, message }),
  receipt: null,
});

const codes = (entry: BurstEntry, entries: BurstEntry[] = [entry]): ConcernCode[] =>
  entryConcerns(entry, { entries }).map((c) => c.code);

// ------------------------------------------------------------- the quiet case

const clean = row(receipt());
check("a receipt that reads cleanly gets no warning", codes(clean).length === 0, codes(clean).join(","));
check("and looksFine agrees", looksFine(clean, { entries: [clean] }));
// Incomplete is normal. Most receipts never yield a subtotal or line items, and
// warning about that would put a pill on nearly every row.
check("no subtotal is not a warning", codes(row(receipt({ subtotal: null }))).length === 0);
check("no tax figure is not a warning", codes(row(receipt({ tax: null }))).length === 0);
check("no date is not a warning", codes(row(receipt({ purchaseDate: null }))).length === 0);
check(
  "no payment method is not a warning",
  codes(row(receipt({ paymentRaw: null, paymentLabel: null }))).length === 0,
);
check("a zero-total receipt is not itself a warning", codes(row(receipt({ subtotal: 0, tax: 0, total: 0 }))).length === 0);

// providers/ocr.ts drops line items with a non-positive amount, so a coupon is
// discarded while the goods remain. The goods then legitimately exceed the
// total, and an "items come to more than the total" rule flagged ordinary
// receipts. There is no such rule any more, and there must not be one again.
check(
  "line items exceeding the total are NOT flagged - a dropped discount looks exactly like that",
  codes(
    row(
      receipt({
        total: 1500,
        subtotal: 1500,
        tax: 0,
        lineItems: [
          { id: "l1", description: "Timber", quantity: 1, amount: 1000, linkedScannedItemId: null },
          { id: "l2", description: "Screws", quantity: 1, amount: 1000, linkedScannedItemId: null },
        ],
      }),
    ),
  ).length === 0,
);

// providers/pdf.ts documents the tax-inclusive invoice, where the total
// legitimately equals a tax-inclusive subtotal, and deliberately does not
// "correct" it. Flagging it here would undo that decision on every one.
check(
  "a VAT-inclusive invoice is not called broken",
  codes(row(receipt({ subtotal: 10000, tax: 2000, total: 10000 }))).length === 0,
);

// ------------------------------------------------------------ what does warn

check("a failed read is flagged", codes(row(receipt({ status: "failed" }))).includes("unread"));
check(
  "a failed read says one thing, not five",
  codes(row(receipt({ status: "failed", total: null, merchant: null }))).length === 1,
);
check("a missing total is flagged", codes(row(receipt({ total: null }))).includes("no-total"));
check(
  "the figures not adding up is flagged",
  codes(row(receipt({ subtotal: 1000, tax: 130, total: 1200 }))).includes("does-not-add-up"),
);
check(
  "one cent out still counts as not adding up",
  codes(row(receipt({ subtotal: 1000, tax: 130, total: 1131 }))).includes("does-not-add-up"),
);
check("a missing shop name is flagged", codes(row(receipt({ merchant: null }))).includes("no-merchant"));
check("a blank shop name counts as missing", codes(row(receipt({ merchant: "   " }))).includes("no-merchant"));
// The money is what matters. A missing name must not push a broken total off
// the row, because only the first warning is shown.
const brokenAndNameless = row(receipt({ merchant: null, subtotal: 1000, tax: 130, total: 1200 }));
check("a broken total outranks a missing name", codes(brokenAndNameless)[0] === "does-not-add-up");
check("and the missing name is not also raised", !codes(brokenAndNameless).includes("no-merchant"));

// --------------------------------------------------------------- still moving

const pending = row(receipt({ status: "pending", total: null, merchant: null }));
check("a receipt still being read says so", codes(pending).join(",") === "still-reading");
check("and that is not something to check", entryConcerns(pending, { entries: [pending] })[0].severity === "waiting");

// A photograph with no receipt yet must never vanish from the screen.
const queued = bare("queued");
check("a queued photograph says it is waiting for signal", codes(queued).join(",") === "sending");
check("and that is not something to check", entryConcerns(queued, { entries: [queued] })[0].severity === "waiting");
const sending = bare("uploading");
check("one still uploading says the same", codes(sending).join(",") === "sending");
const notSent = bare("failed");
check("one that was refused DOES need a person", codes(notSent).join(",") === "not-sent");
check("and it is marked as such", entryConcerns(notSent, { entries: [notSent] })[0].severity === "check");
check(
  "a queued photograph's own message is preferred over the generic one",
  entryConcerns(bare("queued", "Saved — but 2 older photos had to be dropped"), { entries: [] })[0].message ===
    "Saved — but 2 older photos had to be dropped",
);

// ------------------------------------------------------------------- verified

// A person has already looked at this one and said it was right. Re-flagging it
// is how a screen teaches people to ignore it.
check(
  "a verified receipt is never flagged, even when the figures disagree",
  codes(row(receipt({ status: "verified", subtotal: 1000, tax: 130, total: 9999, merchant: null }))).length === 0,
);

// ------------------------------------------------------------------ duplicates

const same = { merchant: "Home Hardware", total: 4210, subtotal: 3730, tax: 480 };
const a = row(receipt({ id: "a", ...same }));
const b = row(receipt({ id: "b", ...same }));
const pair = [a, b];
check("the second of an identical pair is flagged", codes(b, pair).includes("identical-to-earlier"));
check("the first is not", !codes(a, pair).includes("identical-to-earlier"));
check(
  "the warning names the photo it matched",
  entryConcerns(b, { entries: pair }).some((c) => c.message.includes("photo 1")),
);
// Being wrong here is worse than being quiet, so the bar is that EVERYTHING
// read off the two is identical - not merely the shop and the total.
const differentShop = row(receipt({ id: "c", merchant: "Tim Hortons", total: 4210, subtotal: 3730, tax: 480 }));
check(
  "the same total at a different shop is not a match",
  !codes(differentShop, [a, differentShop]).includes("identical-to-earlier"),
);
const differentTotal = row(receipt({ id: "d", merchant: "Home Hardware", total: 999, subtotal: 900, tax: 99 }));
check(
  "the same shop at a different total is not a match",
  !codes(differentTotal, [a, differentTotal]).includes("identical-to-earlier"),
);
const differentDay = row(receipt({ id: "e", ...same, purchaseDate: "2026-09-01T00:00:00.000Z" }));
check(
  "the same figures on a different day are not a match",
  !codes(differentDay, [a, differentDay]).includes("identical-to-earlier"),
);
const differentCard = row(receipt({ id: "f", ...same, paymentRaw: "CASH" }));
check(
  "the same figures paid a different way are not a match",
  !codes(differentCard, [a, differentCard]).includes("identical-to-earlier"),
);
const differentLines = row(
  receipt({ id: "g", ...same, lineItems: [{ id: "l", description: "Nails", quantity: 1, amount: 4210, linkedScannedItemId: null }] }),
);
check(
  "the same figures with different items are not a match",
  !codes(differentLines, [a, differentLines]).includes("identical-to-earlier"),
);
// An unread merchant is the commonest field to miss; matching null to null
// would flag every pair of same-priced unread receipts.
const nameless1 = row(receipt({ id: "h", merchant: null, total: 500 }));
const nameless2 = row(receipt({ id: "i", merchant: null, total: 500 }));
check(
  "two unnamed receipts at the same total are not a match",
  !codes(nameless2, [nameless1, nameless2]).includes("identical-to-earlier"),
);
// The message says "everything on this matches", so every field a reader or a
// person can fill in has to be part of the comparison - otherwise the sentence
// is stronger than the check behind it.
const differentRegion = row(receipt({ id: "m", ...same, region: "BC" }));
check(
  "the same figures in a different province are not a match",
  !codes(differentRegion, [a, differentRegion]).includes("identical-to-earlier"),
);
const differentTaxSplit = row(
  receipt({ id: "n", ...same, taxes: [{ code: "GST", ratePpm: 50000, amount: 480 }] }),
);
check(
  "the same figures split into different taxes are not a match",
  !codes(differentTaxSplit, [a, differentTaxSplit]).includes("identical-to-earlier"),
);
const differentCardLabel = row(receipt({ id: "o", ...same, paymentLabel: "Cash" }));
check(
  "the same figures against a different card are not a match",
  !codes(differentCardLabel, [a, differentCardLabel]).includes("identical-to-earlier"),
);
// The photograph itself must NOT be part of it: two pictures of one receipt
// have different image paths and capture ids, which is the whole case.
const otherPhoto = row(receipt({ id: "p", ...same, imagePath: "/uploads/other.jpg", captureId: "different" }));
check(
  "a different photograph of the same receipt still matches",
  codes(otherPhoto, [a, otherPhoto]).includes("identical-to-earlier"),
);

const spaced = row(receipt({ id: "j", ...same, merchant: "  home   HARDWARE " }));
check(
  "a shop name differing only in case and spacing still matches",
  codes(spaced, [a, spaced]).includes("identical-to-earlier"),
);
// The context arrives from a server refresh as freshly deserialised objects, so
// the row under test is EQUAL to its entry but not the same object. An identity
// comparison lost every warning the moment that happened.
check(
  "a row matched by value, not by reference, is still placed in the burst",
  codes({ ...b }, [{ ...a }, { ...b }]).includes("identical-to-earlier"),
);
const zero1 = row(receipt({ id: "k", total: 0, subtotal: 0, tax: 0 }));
const zero2 = row(receipt({ id: "l", total: 0, subtotal: 0, tax: 0 }));
check("two zero totals are not called duplicates", !codes(zero2, [zero1, zero2]).includes("identical-to-earlier"));

// Three of a kind: the first stays clean, the other two are both flagged, and
// both point at the FIRST.
const t1 = row(receipt({ id: "t1", ...same }));
const t2 = row(receipt({ id: "t2", ...same }));
const t3 = row(receipt({ id: "t3", ...same }));
const three = [t1, t2, t3];
check(
  "in a run of three, only the later two are flagged",
  !codes(t1, three).includes("identical-to-earlier") &&
    codes(t2, three).includes("identical-to-earlier") &&
    codes(t3, three).includes("identical-to-earlier"),
);
check(
  "the third points at the first, not at the second",
  entryConcerns(t3, { entries: three }).some((c) => c.message.includes("photo 1")),
);

// The row number is the position on SCREEN, including photographs that have no
// receipt. Numbering the receipts alone made "photo 1" mean the second row.
const withGap = [bare("queued"), t1, t2];
check(
  "a queued photograph still occupies a row, so the numbering stays true",
  entryConcerns(t2, { entries: withGap }).some((c) => c.message.includes("photo 2")),
  entryConcerns(t2, { entries: withGap }).map((c) => c.message).join(" / "),
);

// -------------------------------------------------------------------- summary

const mixed = [
  row(receipt({ id: "s1" })),
  row(receipt({ id: "s2", total: null })),
  row(receipt({ id: "s3", status: "pending", subtotal: null, tax: null, total: null, merchant: null })),
];
const sum = summariseBurst(mixed);
check("the summary counts the clean one", sum.fine === 1, String(sum.fine));
check("the summary counts the one to check", sum.needsCheck === 1, String(sum.needsCheck));
check("the summary counts the one still reading", sum.waiting === 1, String(sum.waiting));
check("every row is counted exactly once", sum.fine + sum.needsCheck + sum.waiting === mixed.length);
check("the total leaves out what has no total", sum.totalCents === 1130, String(sum.totalCents));
check("and says how many rows that was", sum.missingTotals === 2, String(sum.missingTotals));
check("with no duplicates claimed", sum.duplicates === 0);

const dupSum = summariseBurst(pair);
check("a duplicate pair reports one duplicate, not two", dupSum.duplicates === 1, String(dupSum.duplicates));
// The two ways the headline figure can be wrong pull in opposite directions, so
// the screen must not report one when the other is true.
check("a duplicate does not make the total look incomplete", dupSum.missingTotals === 0);

// The offline case, which is the one that used to render as "$0.00, all good".
const offline = [bare("queued"), bare("queued"), bare("failed")];
const offlineSum = summariseBurst(offline);
check("three unsent photographs are all accounted for", offlineSum.fine + offlineSum.needsCheck + offlineSum.waiting === 3);
check("none of them is called fine", offlineSum.fine === 0, String(offlineSum.fine));
check("the two queued ones are waiting", offlineSum.waiting === 2, String(offlineSum.waiting));
check("the refused one needs a person", offlineSum.needsCheck === 1, String(offlineSum.needsCheck));
check("and all three are counted as contributing no money", offlineSum.missingTotals === 3);
check("a burst of nothing but unsent photos totals zero", offlineSum.totalCents === 0);

const empty = summariseBurst([]);
check(
  "an empty burst summarises to nothing",
  empty.fine === 0 && empty.needsCheck === 0 && empty.waiting === 0 && empty.totalCents === 0 &&
    empty.missingTotals === 0 && empty.duplicates === 0,
);

// A burst where everything is fine is the common case, and the one the footer
// button's wording depends on.
const allFine = [
  row(receipt({ id: "n1", subtotal: 90, tax: 10, total: 100 })),
  row(receipt({ id: "n2", subtotal: 180, tax: 20, total: 200, merchant: "Tim Hortons" })),
];
const fineSum = summariseBurst(allFine);
check("a clean burst reports nothing to check", fineSum.needsCheck === 0 && fineSum.waiting === 0);
check("and its total is the sum of its receipts", fineSum.totalCents === 300);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
