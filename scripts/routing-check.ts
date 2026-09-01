// Checks for the GL routing resolver.
//
//   npm run check:routing
//
// Covers the behaviours that are easy to break and expensive to get wrong:
// per-dimension first-write-wins, all-or-nothing token resolution, and the
// refusal to write dimensions this company does not book against.

import { resolveRouting, type ExpenseFacts, type RoutingContext } from "../src/lib/m3/routing";
import type { GlRoutingRule } from "../src/lib/m3/config";

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "  ok  " : "  FAIL"} ${name}${detail && !passed ? ` — ${detail}` : ""}`);
  if (!passed) failures++;
}

const facts: ExpenseFacts = {
  merchant: "shell", expenseCategory: "fuel", productCategory: null,
  reasonType: "travel", jobNumber: "J-100", userGroup: "Field Team",
  userTitle: "Installer", paymentType: "card", amountCents: 5000,
  hasJob: true, isCompanyCard: false, hasTax: true,
};
const ctx: RoutingContext = {
  jobNumber: "J-100", userGroupName: "Field Team",
  userCostCentre: "ADD3", reasonType: "travel", divi: "CA1",
};
const rule = (o: Partial<GlRoutingRule>): GlRoutingRule => ({
  id: "r", name: "r", enabled: true, precedence: 100, cono: null, divi: null,
  conditions: [], accounting: {}, terminal: false, ...o,
} as GlRoutingRule);

const base = { cono: 100, divi: "CA1" };

// --- per-dimension first-write-wins ---------------------------------------
{
  const r = resolveRouting([
    rule({ id: "a", precedence: 100, accounting: { "1": "7210" } }),
    rule({ id: "b", precedence: 200, accounting: { "1": "9999", "3": "ADD8" } }),
  ], facts, ctx, base);
  check("narrow rule keeps its account, broad rule still adds AIT3",
    r.status === "routed" && r.accounting["1"] === "7210" && r.accounting["3"] === "ADD8",
    r.status === "routed" ? JSON.stringify(r.accounting) : r.status);
}

// --- the token that used to be dead ---------------------------------------
{
  const r = resolveRouting([rule({ accounting: { "1": "7210", "3": "{{user.costCentre}}" } })], facts, ctx, base);
  check("{{user.costCentre}} resolves from the claimant's assignment",
    r.status === "routed" && r.accounting["3"] === "ADD3",
    r.status === "routed" ? JSON.stringify(r.accounting) : r.status);
}
{
  const r = resolveRouting([rule({ accounting: { "1": "7210", "3": "{{user.costCentre}}" } })],
    facts, { ...ctx, userCostCentre: null }, base);
  check("an unassigned cost centre skips the WHOLE rule, not just that field",
    r.status === "incomplete", r.status);
}

// --- dimensions this company does not book against ------------------------
{
  const r = resolveRouting([rule({ accounting: { "1": "7210", "6": "NOPE" } })], facts, ctx,
    { ...base, enabledDimensions: ["1", "2", "3", "4", "5"] });
  check("a rule naming a disabled dimension contributes nothing",
    r.status === "incomplete", r.status === "routed" ? JSON.stringify(r.accounting) : r.status);
}
{
  const r = resolveRouting([rule({ accounting: { "1": "7210", "5": "FRT" } })], facts, ctx,
    { ...base, enabledDimensions: ["1", "2", "3", "4", "5"] });
  check("an enabled dimension is still written", r.status === "routed" && r.accounting["5"] === "FRT");
}

// --- ordering is deterministic --------------------------------------------
{
  const a = resolveRouting([
    rule({ id: "zzz", precedence: 100, accounting: { "1": "AAA" } }),
    rule({ id: "aaa", precedence: 100, accounting: { "1": "BBB" } }),
  ], facts, ctx, base);
  check("equal precedence resolves by id, not array order",
    a.status === "routed" && a.accounting["1"] === "BBB",
    a.status === "routed" ? a.accounting["1"] : a.status);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
