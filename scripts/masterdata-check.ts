// Checks for the accounting master-data validation.
//
//   npm run check:masterdata
//
// The cases that matter are the ones where a code LOOKS fine: a value that is
// real but belongs to another division, one that expired before the period
// being booked, and a summary level that is not postable.

import { validateAccountingString, catalogueState, DimensionCatalogue } from "../src/lib/m3/masterData";
import { accountingDateFor } from "../src/lib/m3/build";

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "  ok  " : "  FAIL"} ${name}${detail && !passed ? ` — ${detail}` : ""}`);
  if (!passed) failures++;
}

const cat = DimensionCatalogue.parse({
  syncedAt: new Date().toISOString(),
  completeFor: ["1", "3"],
  identities: [
    { dimension: "1", value: "60100", description: "Travel", postable: true },
    { dimension: "1", value: "60000", description: "Expenses rollup", postable: false },
    { dimension: "1", value: "60900", description: "Closed account", validTo: "2025-12-31" },
    { dimension: "1", value: "61000", description: "New account", validFrom: "2026-06-01" },
    { dimension: "1", value: "62000", description: "Blocked", blocked: true },
    { dimension: "3", value: "CC-ADMIN", divi: "D01" },
    { dimension: "3", value: "CC-OTHER", divi: "D02" },
  ],
});
const ctx = { divi: "D01", accountingDate: "2026-03-15", currency: "GBP" };
const reasons = (a: Record<string, string>) => validateAccountingString(cat, a, ctx).map((p) => p.reason);

check("a good string passes", reasons({ "1": "60100", "3": "CC-ADMIN" }).length === 0);
check("an unknown account is caught", reasons({ "1": "99999" })[0] === "unknown_identity");
check("a blocked account is caught", reasons({ "1": "62000" })[0] === "blocked");
check("a summary level is refused", reasons({ "1": "60000" })[0] === "not_postable");

// Validity is judged on the BOOKING date, not today.
check("an account closed before the period is caught", reasons({ "1": "60900" })[0] === "expired");
check("an account not yet open in the period is caught", reasons({ "1": "61000" })[0] === "not_yet_valid");
check("the same account IS valid once the period reaches it",
  validateAccountingString(cat, { "1": "61000" }, { ...ctx, accountingDate: "2026-07-01" }).length === 0);

// Codes repeat across sites; a real code from another division is not this one.
check("a code from another division is refused", reasons({ "1": "60100", "3": "CC-OTHER" })[0] === "wrong_division");
check("a disabled dimension is refused",
  validateAccountingString(cat, { "1": "60100", "6": "X" }, { ...ctx, enabledDimensions: ["1", "2", "3", "4", "5"] })[0]
    ?.reason === "dimension_disabled");

// An empty catalogue must not block every posting in a fresh deployment.
check("an empty catalogue has no opinion",
  validateAccountingString(DimensionCatalogue.parse({}), { "1": "anything" }, ctx).length === 0);
check("an empty catalogue reports 'missing'", catalogueState(DimensionCatalogue.parse({})) === "missing");
// The important one: stale must still VALIDATE, not silently switch off.
const staleCat = DimensionCatalogue.parse({
  syncedAt: "2020-01-01T00:00:00.000Z", completeFor: ["1"], identities: cat.identities,
});
check("an old catalogue reports 'stale', not 'missing'", catalogueState(staleCat) === "stale");
check("a stale catalogue still catches a blocked account",
  validateAccountingString(staleCat, { "1": "62000" }, ctx)[0]?.reason === "blocked");

// A partial sync must not turn every un-synced code into an error.
const partial = DimensionCatalogue.parse({
  syncedAt: new Date().toISOString(), completeFor: ["1"], identities: cat.identities,
});
check("an unknown code in a COMPLETE dimension is rejected",
  validateAccountingString(partial, { "1": "99999" }, ctx)[0]?.reason === "unknown_identity");
check("an unknown code in an INCOMPLETE dimension is allowed",
  validateAccountingString(partial, { "1": "60100", "4": "870" }, ctx).length === 0);

// Accounting date basis.
const approved = new Date("2026-03-20T10:00:00Z");
const receipts = [new Date("2026-02-28T00:00:00Z"), new Date("2026-03-02T00:00:00Z"), null];
check("approval basis uses the approval date",
  accountingDateFor("approval", approved, receipts).date === "2026-03-20");
check("receipt basis uses the LATEST receipt, not the earliest",
  accountingDateFor("receipt", approved, receipts).date === "2026-03-02");
check("receipt basis falls back when no receipt has a date",
  accountingDateFor("receipt", approved, [null, null]).fellBack === true);
check("a receipt dated after approval is ignored, not booked into the future",
  accountingDateFor("receipt", approved, [new Date("2026-03-02T00:00:00Z"), new Date("2027-01-01T00:00:00Z")]).date === "2026-03-02");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
