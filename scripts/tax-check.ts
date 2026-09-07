// Checks for the receipt tax split.
//
//   npm run check:tax
//
// The property that matters is that the parts always sum to the receipt's own
// total - the paper in the user's hand is the authority, and an app that
// disagrees with it by a penny is an app nobody trusts.

import { splitTax, taxLabel, componentsBalance } from "../src/lib/tax";
import { parseToCents, centsToInput } from "../src/lib/money";

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
check("a whole rate reads cleanly", taxLabel({ code: "GST", ratePpm: 50000, amount: 0 }) === "GST 5%");
check("Quebec 9.975% survives exactly", taxLabel({ code: "QST", ratePpm: 99750, amount: 0 }) === "QST 9.975%");
check("an unmapped tax is called Sales tax", taxLabel({ code: "SALES", ratePpm: 0, amount: 0 }) === "Sales tax");

check("componentsBalance catches a mismatch", !componentsBalance([{ amount: 100 }], 101));

// Money parsing, which the receipt screen leans on while the user is typing.
check("a partly typed value is not read as zero", parseToCents("") === null && parseToCents("-") === null && parseToCents(".") === null);
check("1.005 rounds up, not down through float error", parseToCents("1.005") === 101);
check("currency decoration is ignored", parseToCents("$1,299.00") === 129900);
check("a negative amount survives", parseToCents("-4.50") === -450);
check("nonsense is null, not NaN", parseToCents("abc") === null);
// Blind character-stripping used to turn these into plausible-looking numbers.
check("scientific notation is refused, not silently rewritten", parseToCents("1e3") === null);
check("a stray letter refuses the whole value", parseToCents("12x.50") === null);
check("an absurd amount is refused rather than overflowing", parseToCents("99999999999999") === null);
check("negative zero normalises to zero", Object.is(parseToCents("-0.00"), 0));
check("thousands separators still parse", parseToCents("1,234.56") === 123456);
check("round-trips through the input format", parseToCents(centsToInput(12345)) === 12345);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
