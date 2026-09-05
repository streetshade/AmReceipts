// Checks for the APS450MI supplier-invoice route.
//
//   npm run check:aps450
//
// The point of these is that the sequence is correct and that NOTHING sends an
// accounting string - M3 derives the coding itself, and a connector that
// quietly started supplying one would be silently wrong.

import {
  buildAps450Steps, applyBatchNo, Aps450Config, preflightVerdict, readOutcome,
  buildVoucherReadback, assertClaimBalances, ClaimInvariantError,
} from "../src/lib/m3/aps450";
import { supplierInvoiceNo, correlationId, postingReference } from "../src/lib/m3/reference";

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "  ok  " : "  FAIL"} ${name}${detail && !passed ? ` — ${detail}` : ""}`);
  if (!passed) failures++;
}

const config = Aps450Config.parse({ divi: "D01", vtcd: 81, receiptInfoCategory: 10, requiresApproval: true });
const claim = {
  supplierInvoiceNo: supplierInvoiceNo("session-1"),
  correlationId: correlationId("session-1"),
  supplierNo: "E00123",
  invoiceDate: "2026-03-02",
  accountingDate: "2026-03-02",
  currency: "CAD",
  totalCents: 19800,
  taxCents: 3300,
  lines: [
    { lineNo: 1, amountCents: 12000, taxCents: 2000, description: "Hotel", receiptId: "rc1" },
    { lineNo: 2, amountCents: 4500, taxCents: 1300, description: "Meals with a very long description indeed", receiptId: "rc2" },
  ],
};

const steps = buildAps450Steps(config, claim);
const kinds = steps.map((s) => s.kind);

check("the sequence is preflight, head, lines, addinfo, approve, validate, verify",
  JSON.stringify(kinds) === JSON.stringify(["preflight","head","line","line","addinfo","addinfo","approve","validate","verify"]),
  JSON.stringify(kinds));

check("only ValidByBatchNo commits", steps.filter((s) => s.commits).length === 1 &&
  steps.find((s) => s.commits)?.transaction === "ValidByBatchNo");

// APS455MI takes INBN and nothing else.
check("ValidByBatchNo sends INBN only", (() => {
  const v = steps.find((s) => s.kind === "validate")!;
  applyBatchNo([v], "1");
  return Object.keys(v.params).join(",") === "INBN";
})());

// Approval must not be invented where the workflow does not use it.
check("approval is omitted when the installation does not require it",
  !buildAps450Steps(Aps450Config.parse({ divi: "D01" }), claim).some((s) => s.kind === "approve"));

// The whole point of the rewrite.
const ACCOUNTING = /^(AIT[1-7]|ANBR|ACCT|COST|DIM\d?)$/;
const offending = steps.flatMap((s) => Object.keys(s.params).filter((k) => ACCOUNTING.test(k)));
check("NO step sends an account or an accounting dimension", offending.length === 0, offending.join(","));

check("the head carries SINO and CORI", (() => {
  const h = steps.find((s) => s.kind === "head")!.params;
  return h.SINO === claim.supplierInvoiceNo && h.CORI === claim.correlationId;
})());

check("the accounting date is sent as ACDT",
  steps.find((s) => s.kind === "head")!.params.ACDT === "2026-03-02");

check("CHGT is truncated to the field's 30 characters",
  (steps.filter((s) => s.kind === "line")[1].params.CHGT ?? "").length === 30);

check("preflight asks LstInvBySupInv with our SINO",
  steps[0].transaction === "LstInvBySupInv" && steps[0].params.SINO === claim.supplierInvoiceNo);

// Batch number substitution.
applyBatchNo(steps, "556677");
check("every step that needs INBN receives it",
  steps.filter((s) => s.needsBatchNo).every((s) => s.params.INBN === "556677"));
check("preflight and head do NOT get an INBN",
  steps[0].params.INBN === undefined && steps[1].params.INBN === undefined);

// Identifiers.
check("SINO fits A(24) and is deterministic",
  supplierInvoiceNo("s").length <= 24 && supplierInvoiceNo("s") === supplierInvoiceNo("s"));
check("CORI fits A(36), is opaque and deterministic",
  correlationId("s").length === 36 && /^AMRC[0-9A-Z]{32}$/.test(correlationId("s")) &&
  correlationId("s") === correlationId("s"));
// It must not pretend to be randomly generated.
check("CORI does not masquerade as a v4 UUID",
  !/^[0-9a-f]{8}-[0-9a-f]{4}-4/.test(correlationId("s")));
check("SINO and CORI differ for the same session",
  supplierInvoiceNo("s") !== correlationId("s"));
check("different sessions get different identifiers",
  supplierInvoiceNo("a") !== supplierInvoiceNo("b") && correlationId("a") !== correlationId("b"));

// Reading M3 back. A staged batch is NOT a posted one - AddHead alone creates
// one, so an attempt that died before validation leaves exactly this.
check("an existing batch reports 'exists', not 'posted'",
  preflightVerdict([{ INBN: "998877", SUPA: "20" }]).state === "exists");
check("no batch means safe to create one", preflightVerdict([]).state === "absent");
check("INBN of 0 is not a batch", preflightVerdict([{ INBN: "0" }]).state === "absent");

// Claims that do not add up must never reach M3.
check("a balanced claim is accepted", (() => {
  try { assertClaimBalances(claim, false); return true; } catch { return false; }
})());
check("a claim whose lines disagree with its total is refused", (() => {
  try { assertClaimBalances({ ...claim, totalCents: 1 }, false); return false; }
  catch (e) { return e instanceof ClaimInvariantError; }
})());
check("a claim whose line tax disagrees with its stated tax is refused", (() => {
  try { assertClaimBalances({ ...claim, taxCents: 99 }, false); return false; }
  catch (e) { return e instanceof ClaimInvariantError; }
})());

// The GL readback - the only way to see what AP50 actually did.
check("the voucher readback targets GLS200MI/LstVoucherLines", (() => {
  const r = buildVoucherReadback("D01", "2026", "12345");
  return r.program === "GLS200MI" && r.transaction === "LstVoucherLines" &&
    r.params.DIVI === "D01" && r.params.YEA4 === "2026" && r.params.VONO === "12345";
})());
check("GetHead error flags are read", (() => {
  const o = readOutcome({ IBHE: "1", IBLE: "0", VONO: "12345", YEA4: "2026" });
  return o.headError && !o.lineError && o.voucherNo === "12345" && o.fiscalYear === "2026";
})());
check("a clean batch reports no errors and a voucher",
  (() => { const o = readOutcome({ IBHE: "0", IBLE: "0", VONO: "777", YEA4: "2026" }); return !o.headError && !o.lineError && o.voucherNo === "777"; })());

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
