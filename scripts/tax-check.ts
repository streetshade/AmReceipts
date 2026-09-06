// Checks for the receipt tax split.
//
//   npm run check:tax
//
// The property that matters is that the parts always sum to the receipt's own
// total - the paper in the user's hand is the authority, and an app that
// disagrees with it by a penny is an app nobody trusts.

import { splitTax, taxLabel, componentsBalance } from "../src/lib/tax";

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "  ok  " : "  FAIL"} ${name}${detail && !passed ? ` — ${detail}` : ""}`);
  if (!passed) failures++;
}

const sum = (c: { amount: number }[]) => c.reduce((s, x) => s + x.amount, 0);

// Two-part provinces.
const bc = splitTax("CA", "BC", 1200);
check("BC splits into GST and PST", bc.map((c) => c.code).join(",") === "GST,PST");
check("BC parts sum to the receipt total", sum(bc) === 1200, String(sum(bc)));

// Single-rate provinces.
const on = splitTax("CA", "ON", 1300);
check("Ontario is a single HST line", on.length === 1 && on[0].code === "HST" && on[0].amount === 1300);
const ab = splitTax("CA", "AB", 500);
check("Alberta is GST only", ab.length === 1 && ab[0].code === "GST");

// Anything unmapped, including the US, is one line.
const us = splitTax("US", "WA", 875);
check("a US receipt is one 'Sales tax' line", us.length === 1 && us[0].code === "SALES" && us[0].amount === 875);
check("an unknown region still balances", sum(splitTax("CA", "ZZ", 999)) === 999);
check("no country at all still balances", sum(splitTax(null, null, 42)) === 42);

// Rounding: the parts must ALWAYS reconcile, at every awkward value.
let allBalance = true;
for (let cents = 0; cents <= 2000; cents++) {
  for (const [c, r] of [["CA", "BC"], ["CA", "QC"], ["CA", "SK"], ["CA", "ON"], ["US", "OR"]] as const) {
    if (sum(splitTax(c, r, cents)) !== cents) { allBalance = false; break; }
  }
}
check("every value from 0 to 2000 cents reconciles across provinces", allBalance);

check("zero tax produces no lines", splitTax("CA", "BC", 0).length === 0);

// Labels.
check("a whole rate reads cleanly", taxLabel({ code: "GST", rateBasisPoints: 500, amount: 0 }) === "GST 5%");
check("a fractional rate keeps its precision", taxLabel({ code: "QST", rateBasisPoints: 998, amount: 0 }) === "QST 9.98%");
check("an unmapped tax is called Sales tax", taxLabel({ code: "SALES", rateBasisPoints: 0, amount: 0 }) === "Sales tax");

check("componentsBalance catches a mismatch", !componentsBalance([{ amount: 100 }], 101));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
