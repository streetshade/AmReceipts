// The APS450MI supplier-invoice batch route — the real one.
//
// This replaces the generic head/lines/confirm voucher poster for M3, because
// the M3 API repository settled what that route actually accepts, and it is
// not what the generic model assumed.
//
// THE CENTRAL FACT. Across AddHead (63 inputs), AddLine (37) and AddAddInfo
// (5), there is no account, no cost centre and no accounting dimension. M3
// derives the coding itself, from FAM accounting rules on event AP50 plus the
// invoice accounting template (REGR) on the supplier record. The claimant does
// not choose an account; neither does the caller. Anything in this connector
// that resolves an accounting string is therefore not part of THIS path - see
// routing.ts, which remains in use for integrations that do accept coding.
//
// What the route gives back in exchange is worth more than what it takes away:
//
//   SINO  A(24)  supplier invoice number. AP uniqueness is SPYN+SUNO+SINO+INYR,
//                so a repeated claim is REJECTED by M3 rather than duplicated.
//                Native idempotency, enforced by the ledger itself.
//   CORI  A(36)  correlation id, present expressly to tie a voucher back to the
//                system that fed it.
//   ACDT  D(10)  accounting date - the period is ours to choose, explicitly.
//
// And it is verifiable after the fact, which the generic model could not be:
//   APS450MI/LstInvBySupInv(SPYN, SUNO, SINO) -> INBN, SUPA
//     answers "did this claim already post?" without guessing.
//   APS450MI/GetHead(INBN) -> IBHE, IBLE, VONO, YEA4
//     surfaces batch errors and the resulting voucher identity.
//   GLS200MI/LstVoucherLines(DIVI, YEA4, VONO)
//     reads back the coding M3 actually applied - the only way to see what the
//     AP50 rules did with a claim.

import { z } from "zod";

/** Line type on AddLine. 8 is the expense/cost line in this route. */
export const DEFAULT_LINE_TYPE = 8;

export const Aps450Config = z.object({
  /** Division the claim is posted in. */
  divi: z.string().length(3),
  /** Invoice batch type. Installation-configured; blank lets M3 default it. */
  ibtp: z.string().max(2).default(""),
  /** Line type for an expense line. */
  rdtp: z.number().int().min(1).max(99).default(DEFAULT_LINE_TYPE),
  /** Default VAT code where a line does not carry one. */
  vtcd: z.number().int().min(0).max(99).optional(),
  /** Payment terms and method override the supplier defaults when set. */
  tepy: z.string().max(3).optional(),
  pyme: z.string().max(3).optional(),
  /**
   * AP information category used to attach receipt references through
   * AddAddInfo. Installation-configured; without it the receipt link is simply
   * not sent rather than guessed at.
   */
  receiptInfoCategory: z.number().int().min(1).max(999).optional(),
  /**
   * Whether this installation's batch workflow expects ApproveInvoice.
   *
   * Off by default. Calling it unconditionally would either be rejected where
   * approval is not configured, or - worse - record an approval event in M3
   * that no M3 approver actually performed.
   */
  requiresApproval: z.boolean().default(false),
  /**
   * Post as tax-inclusive. The employee-supplier convention in this estate is
   * net amounts with VAT stated separately, which is TXIN = 0.
   */
  taxIncluded: z.boolean().default(false),
});
export type Aps450Config = z.infer<typeof Aps450Config>;

/** A claim, already prepared - amounts in integer cents. */
export interface Aps450Claim {
  /** Deterministic. Becomes SINO, and is what makes M3 reject a repeat. */
  supplierInvoiceNo: string;
  /** Deterministic. Becomes CORI, for correlating back to this app. */
  correlationId: string;
  supplierNo: string;
  /** Payee, where it differs from the supplier. Usually the same. */
  payeeNo?: string | null;
  /** Date on the claim itself. */
  invoiceDate: string; // YYYY-MM-DD
  /** Period the voucher is booked into. */
  accountingDate: string; // YYYY-MM-DD
  currency: string;
  totalCents: number;
  taxCents: number;
  lines: {
    lineNo: number;
    amountCents: number;
    taxCents: number;
    vatCode?: number | null;
    /** CHGT A(30) - free text on the line, the only description M3 takes here. */
    description: string;
    /** Reference back to the receipt this line came from. */
    receiptId?: string | null;
  }[];
}

export type Aps450StepKind =
  | "preflight"
  | "head"
  | "line"
  | "addinfo"
  | "approve"
  | "validate"
  | "verify";

export interface Aps450Step {
  kind: Aps450StepKind;
  program: string;
  transaction: string;
  params: Record<string, string>;
  /**
   * True only for ValidByBatchNo. Everything before it stages a batch that has
   * not touched the ledger: a failure there leaves an unvalidated batch, which
   * is untidy but is not a posting. This is the one call whose unknown outcome
   * means a voucher may exist.
   */
  commits: boolean;
  /** Needs INBN from the head call substituted in before dispatch. */
  needsBatchNo: boolean;
  lineNo?: number;
}

const money = (cents: number) => (cents / 100).toFixed(2);
const m3Date = (iso: string) => iso; // D(10) fields take ISO; M3 accepts yyyy-mm-dd

function put(target: Record<string, string>, field: string, value: string | number | null | undefined) {
  if (value === null || value === undefined) return;
  const s = String(value);
  if (s.trim() === "") return;
  target[field] = s;
}

/**
 * Build the call sequence for one claim.
 *
 * Pure, so the exact parameters can be shown in a dry run and stored in the
 * audit trail before anything is sent.
 */
export function buildAps450Steps(config: Aps450Config, claim: Aps450Claim): Aps450Step[] {
  const steps: Aps450Step[] = [];
  const payee = claim.payeeNo || claim.supplierNo;

  // 1. Has this claim already posted? Asked BEFORE writing anything, so a
  // retry after an unknown outcome resolves itself instead of escalating to a
  // human. This is the query the earlier design wished existed.
  const preflight: Record<string, string> = {};
  put(preflight, "DIVI", config.divi);
  put(preflight, "SPYN", payee);
  put(preflight, "SUNO", claim.supplierNo);
  put(preflight, "SINO", claim.supplierInvoiceNo);
  steps.push({
    kind: "preflight",
    program: "APS450MI",
    transaction: "LstInvBySupInv",
    params: preflight,
    commits: false,
    needsBatchNo: false,
  });

  // 2. The batch header.
  const head: Record<string, string> = {};
  put(head, "DIVI", config.divi);
  put(head, "SUNO", claim.supplierNo);
  put(head, "SPYN", claim.payeeNo);
  put(head, "IVDT", m3Date(claim.invoiceDate));
  put(head, "ACDT", m3Date(claim.accountingDate));
  put(head, "SINO", claim.supplierInvoiceNo);
  put(head, "CORI", claim.correlationId);
  put(head, "CUCD", claim.currency);
  put(head, "IBTP", config.ibtp);
  put(head, "TEPY", config.tepy);
  put(head, "PYME", config.pyme);
  put(head, "TXIN", config.taxIncluded ? 1 : 0);
  put(head, "VTAM", money(claim.taxCents));
  put(head, "CUAM", money(claim.totalCents));
  steps.push({ kind: "head", program: "APS450MI", transaction: "AddHead", params: head, commits: false, needsBatchNo: false });

  // 3. One line per expense line. No account: see the note at the top.
  for (const line of claim.lines) {
    const p: Record<string, string> = {};
    put(p, "DIVI", config.divi);
    put(p, "RDTP", config.rdtp);
    put(p, "NLAM", money(line.amountCents));
    put(p, "VTA1", line.taxCents > 0 ? money(line.taxCents) : undefined);
    put(p, "VTCD", line.vatCode ?? config.vtcd);
    // CHGT is A(30). Truncated deliberately rather than risking a rejection on
    // length for what is only a description.
    put(p, "CHGT", line.description.slice(0, 30));
    steps.push({
      kind: "line",
      program: "APS450MI",
      transaction: "AddLine",
      params: p,
      commits: false,
      needsBatchNo: true,
      lineNo: line.lineNo,
    });
  }

  // 4. Receipt references, if the installation has an information category for
  // them. Skipped rather than guessed when it is not configured.
  if (config.receiptInfoCategory !== undefined) {
    claim.lines
      .filter((l) => l.receiptId)
      .forEach((l, i) => {
        const p: Record<string, string> = {};
        put(p, "DIVI", config.divi);
        put(p, "PEXN", config.receiptInfoCategory);
        put(p, "PEXI", `${l.lineNo}:${l.receiptId}`.slice(0, 45));
        put(p, "PEXS", i + 1);
        steps.push({
          kind: "addinfo",
          program: "APS450MI",
          transaction: "AddAddInfo",
          params: p,
          commits: false,
          needsBatchNo: true,
          lineNo: l.lineNo,
        });
      });
  }

  // 5. Approval, captured inside M3 rather than only in this app - but only
  // where the installation's workflow actually expects it.
  if (config.requiresApproval) {
    const approve: Record<string, string> = {};
    put(approve, "DIVI", config.divi);
    put(approve, "AAPD", m3Date(claim.accountingDate));
    put(approve, "YRE1", claim.correlationId);
    steps.push({ kind: "approve", program: "APS450MI", transaction: "ApproveInvoice", params: approve, commits: false, needsBatchNo: true });
  }

  // 6. The only irreversible call: creates the AP liability and the GL voucher,
  // coded from the AP50 rules.
  // INBN only. The repository lists no other input on this transaction, and
  // sending DIVI - which every other call in the sequence takes - risks a
  // rejection on the one call that must not fail for a trivial reason.
  steps.push({
    kind: "validate",
    program: "APS455MI",
    transaction: "ValidByBatchNo",
    params: {},
    commits: true,
    needsBatchNo: true,
  });

  // 7. Read back what happened. IBHE/IBLE carry batch errors that a successful
  // HTTP response to the validate call does not reveal - the silent-failure
  // hole the earlier design had no answer for.
  steps.push({
    kind: "verify",
    program: "APS450MI",
    transaction: "GetHead",
    params: { ...(config.divi ? { DIVI: config.divi } : {}) },
    commits: false,
    needsBatchNo: true,
  });

  return steps;
}

/** Substitute the batch number returned by AddHead into the steps that need it. */
export function applyBatchNo(steps: Aps450Step[], inbn: string): void {
  for (const step of steps) {
    if (step.needsBatchNo) step.params.INBN = inbn;
  }
}

/** What GetHead says about a batch after validation. */
export interface Aps450Outcome {
  headError: boolean;
  lineError: boolean;
  voucherNo: string | null;
  fiscalYear: string | null;
  batchStatus: string | null;
}

export function readOutcome(record: Record<string, string> | undefined): Aps450Outcome {
  const r = record ?? {};
  const flag = (v: string | undefined) => v !== undefined && v !== "" && v !== "0";
  return {
    headError: flag(r.IBHE),
    lineError: flag(r.IBLE),
    voucherNo: r.VONO && r.VONO !== "0" ? r.VONO : null,
    fiscalYear: r.YEA4 && r.YEA4 !== "0" ? r.YEA4 : null,
    batchStatus: r.SUPA ?? null,
  };
}

export type PreflightVerdict =
  /** Nothing under our SINO. Safe to create the batch. */
  | { state: "absent" }
  /**
   * A batch exists. This is NOT proof it posted: AddHead alone creates one, so
   * an attempt that died between head and validate leaves exactly this. It is
   * proof we must not create a SECOND header - the two claims would be
   * indistinguishable afterwards - and it is a batch to resume or investigate.
   */
  | { state: "exists"; batchNo: string; status: string | null };

/**
 * What the preflight tells us about a claim already in M3.
 *
 * Deliberately does not answer "did it post?". LstInvBySupInv returns a batch
 * number and a status, and the status codes are installation metadata this
 * export does not define - so the honest answer is "a batch exists, go and
 * look", which GetHead can then settle from IBHE/IBLE/VONO. An earlier version
 * reported any batch as `posted: true`, which would have marked a staged,
 * never-validated batch as a completed posting.
 */
export function preflightVerdict(records: Record<string, string>[]): PreflightVerdict {
  const hit = records.find((r) => r.INBN && r.INBN !== "0");
  return hit ? { state: "exists", batchNo: hit.INBN, status: hit.SUPA ?? null } : { state: "absent" };
}

/** Read back the coding M3 actually applied. Only possible once a voucher exists. */
export function buildVoucherReadback(divi: string, fiscalYear: string, voucherNo: string): Aps450Step {
  return {
    kind: "verify",
    program: "GLS200MI",
    transaction: "LstVoucherLines",
    params: { DIVI: divi, YEA4: fiscalYear, VONO: voucherNo },
    commits: false,
    needsBatchNo: false,
  };
}

export class ClaimInvariantError extends Error {}

/**
 * Refuse a claim whose amounts do not add up.
 *
 * With TXIN = 0 the header total is gross while the lines are net, so nothing
 * in the field mapping itself would catch a claim whose parts disagree - it
 * would simply post a wrong number. Checked here, before dispatch, where the
 * failure is a blocked posting rather than a bad voucher.
 */
export function assertClaimBalances(claim: Aps450Claim, taxIncluded: boolean): void {
  const net = claim.lines.reduce((s, l) => s + l.amountCents, 0);
  const tax = claim.lines.reduce((s, l) => s + l.taxCents, 0);
  const expected = taxIncluded ? net : net + tax;

  if (expected !== claim.totalCents) {
    throw new ClaimInvariantError(
      `Claim does not balance: lines total ${(expected / 100).toFixed(2)} but the claim states ${(claim.totalCents / 100).toFixed(2)}`,
    );
  }
  if (tax !== claim.taxCents) {
    throw new ClaimInvariantError(
      `Line tax totals ${(tax / 100).toFixed(2)} but the claim states ${(claim.taxCents / 100).toFixed(2)}`,
    );
  }
  if (claim.lines.length === 0) throw new ClaimInvariantError("Claim has no lines");
}
