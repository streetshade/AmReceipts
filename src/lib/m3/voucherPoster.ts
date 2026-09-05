// How a voucher is actually built and sent to M3.
//
// Config-driven, not hardcoded. This mirrors what an existing internal M3 integration
// integration learned the hard way: MI transactions and their field names are
// defined PER INSTALLATION, so that portal keeps its field mapping in config
// and ships a probe script to discover the real names. Guessing them in code
// produced "field not found" errors that looked like outages.
//
// The multi-step shape is the important part. An M3 voucher is not one call:
// it is a header, then a line per posting line, then a confirm. That matters
// enormously for safety, because the steps are NOT equally dangerous:
//
//   head + lines  stage a batch. Until it is confirmed, nothing has reached the
//                 ledger. A failure here can leave a dangling unconfirmed batch
//                 in M3 - untidy, and worth cleaning up, but not a posting.
//   confirm       the single irreversible write. This is the call whose unknown
//                 outcome means a voucher may or may not exist.
//
// Treating all three as one opaque "write" would either over-report ambiguity
// (every network blip becomes a manual reconciliation) or under-report it.

import { z } from "zod";

const MiName = z.string().regex(/^[A-Za-z0-9_]+$/, "MI names are alphanumeric plus underscore");
/** An MI input field name, e.g. "PUNO". Same charset rule as program names. */
const FieldName = z.string().regex(/^[A-Za-z0-9_]+$/);

// Where each piece of our data goes in this installation's MI transaction.
// Every entry is optional because builds differ; anything unmapped is simply
// not sent, and M3 applies its own default.
const HeadFields = z.object({
  // The external reference. NOT optional: without somewhere to put it, an
  // ambiguous posting cannot be reconciled, which removes the only safety net
  // this integration has.
  reference: FieldName,
  company: FieldName.optional(),
  division: FieldName.optional(),
  accountingDate: FieldName.optional(),
  currency: FieldName.optional(),
  supplier: FieldName.optional(),
  totalAmount: FieldName.optional(),
  description: FieldName.optional(),
  /** Batch identifier returned by head and echoed on line/confirm calls. */
  batchId: FieldName.optional(),
});

const LineFields = z.object({
  batchId: FieldName.optional(),
  lineNo: FieldName.optional(),
  account: FieldName, // AIT1
  dim2: FieldName.optional(),
  dim3: FieldName.optional(),
  dim4: FieldName.optional(),
  dim5: FieldName.optional(),
  dim6: FieldName.optional(),
  dim7: FieldName.optional(),
  amount: FieldName.optional(),
  vatCode: FieldName.optional(),
  description: FieldName.optional(),
});

const ConfirmFields = z.object({
  batchId: FieldName.optional(),
  reference: FieldName.optional(),
});

// Output field names, as this build returns them.
const ResponseFields = z.object({
  batchId: FieldName.optional(),
  voucherNo: FieldName.optional(),
  voucherSeries: FieldName.optional(),
  fiscalYear: FieldName.optional(),
});

/**
 * Fixed MI parameters sent verbatim on every call of a step.
 *
 * This is where installation constants live - FAM function, voucher series,
 * batch type, whatever this build requires. An earlier version named a couple
 * of these as dedicated fields and then never populated them, so a config could
 * validate while silently omitting a required value. An open map cannot rot
 * that way: whatever is written here is what gets sent.
 */
const Constants = z.record(FieldName, z.string()).default({});

export const VoucherPosterConfig = z.object({
  head: z.object({
    program: MiName,
    transaction: MiName,
    fields: HeadFields,
    constants: Constants,
    response: ResponseFields.default({}),
  }),
  line: z.object({
    program: MiName,
    transaction: MiName,
    fields: LineFields,
    constants: Constants,
    // Needed when there is no confirm step and the last line is what commits.
    response: ResponseFields.default({}),
  }),
  // Some builds post a complete voucher in one call and need no confirm step.
  // Omitting it declares that: the LAST call then becomes the dangerous one.
  confirm: z
    .object({
      program: MiName,
      transaction: MiName,
      fields: ConfirmFields,
      constants: Constants,
      response: ResponseFields.default({}),
    })
    .optional(),

  /** Date format this installation expects. M3 usually wants YYYYMMDD. */
  dateFormat: z.enum(["YYYYMMDD", "YYYY-MM-DD"]).default("YYYYMMDD"),
  /**
   * How amounts are expressed. We store integer cents; M3 almost always wants
   * major units ("12.34"). Getting this wrong is a 100x error in the ledger,
   * so it is REQUIRED - no default. A default would mean an unconsidered
   * config silently picks a financially significant interpretation, which is
   * the exact failure the explicitness was meant to prevent.
   */
  amountFormat: z.enum(["major_units", "minor_units"]),
});
export type VoucherPosterConfig = z.infer<typeof VoucherPosterConfig>;

export type PostingStepKind = "head" | "line" | "confirm";

export interface PostingStep {
  kind: PostingStepKind;
  program: string;
  transaction: string;
  params: Record<string, string>;
  /**
   * True for the one call that actually commits the voucher. Only a step with
   * this set can leave the ledger in an unknown state; a failure before it
   * leaves at worst an unconfirmed batch.
   */
  commits: boolean;
  /** Line number this step sends, for the audit trail. */
  lineNo?: number;
}

/** Data the step builder needs. Mirrors a claimed posting plus its lines. */
export interface PostingDocument {
  reference: string;
  cono: string;
  divi: string;
  currency: string;
  accountingDate: string; // YYYY-MM-DD
  supplierNo: string | null;
  amountCents: number;
  postingProfileKey: string;
  lines: {
    lineNo: number;
    dim1: string;
    dim2: string | null;
    dim3: string | null;
    dim4: string | null;
    dim5: string | null;
    dim6: string | null;
    dim7: string | null;
    amountCents: number;
    vatCode: string | null;
    description: string;
  }[];
}

export class VoucherBuildError extends Error {}

function formatDate(iso: string, format: VoucherPosterConfig["dateFormat"]): string {
  // Shape AND validity. "2026-13-40" is the wrong date; "2026-2-03" is the
  // wrong shape and would silently produce "2026203" once the hyphens come
  // out. Both are rejected here, where the failure is a clean blocked posting
  // rather than an MI error someone has to decode.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new VoucherBuildError(`Accounting date ${iso} is not in YYYY-MM-DD form`);
  }
  const [y, m, d] = iso.split("-").map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d
  ) {
    throw new VoucherBuildError(`Accounting date ${iso} is not a real date`);
  }
  return format === "YYYYMMDD" ? iso.replace(/-/g, "") : iso;
}

function formatAmount(cents: number, format: VoucherPosterConfig["amountFormat"]): string {
  return format === "major_units" ? (cents / 100).toFixed(2) : String(cents);
}

/** Assign `value` to `field` only when both are present. */
function put(target: Record<string, string>, field: string | undefined, value: string | null | undefined) {
  if (!field || value === null || value === undefined || value === "") return;
  target[field] = value;
}

/**
 * Build the call sequence for one posting.
 *
 * Pure: no I/O, so the exact parameters can be shown in a dry run and stored in
 * the audit trail before anything is sent.
 */
export function buildSteps(config: VoucherPosterConfig, doc: PostingDocument): PostingStep[] {
  const steps: PostingStep[] = [];
  const date = formatDate(doc.accountingDate, config.dateFormat);

  const headParams: Record<string, string> = { ...config.head.constants };
  put(headParams, config.head.fields.reference, doc.reference);
  put(headParams, config.head.fields.company, doc.cono);
  put(headParams, config.head.fields.division, doc.divi);
  put(headParams, config.head.fields.accountingDate, date);
  put(headParams, config.head.fields.currency, doc.currency);
  put(headParams, config.head.fields.supplier, doc.supplierNo);
  put(headParams, config.head.fields.totalAmount, formatAmount(doc.amountCents, config.amountFormat));
  put(headParams, config.head.fields.description, doc.reference);
  steps.push({
    kind: "head",
    program: config.head.program,
    transaction: config.head.transaction,
    params: headParams,
    commits: false,
  });

  for (const l of doc.lines) {
    const lineParams: Record<string, string> = { ...config.line.constants };
    put(lineParams, config.line.fields.lineNo, String(l.lineNo));
    put(lineParams, config.line.fields.account, l.dim1);
    put(lineParams, config.line.fields.dim2, l.dim2);
    put(lineParams, config.line.fields.dim3, l.dim3);
    put(lineParams, config.line.fields.dim4, l.dim4);
    put(lineParams, config.line.fields.dim5, l.dim5);
    put(lineParams, config.line.fields.dim6, l.dim6);
    put(lineParams, config.line.fields.dim7, l.dim7);
    put(lineParams, config.line.fields.amount, formatAmount(l.amountCents, config.amountFormat));
    put(lineParams, config.line.fields.vatCode, l.vatCode);
    put(lineParams, config.line.fields.description, l.description);
    steps.push({
      kind: "line",
      program: config.line.program,
      transaction: config.line.transaction,
      params: lineParams,
      commits: false,
      lineNo: l.lineNo,
    });
  }

  if (config.confirm) {
    const confirmParams: Record<string, string> = { ...config.confirm.constants };
    put(confirmParams, config.confirm.fields.reference, doc.reference);
    steps.push({
      kind: "confirm",
      program: config.confirm.program,
      transaction: config.confirm.transaction,
      params: confirmParams,
      commits: true,
    });
  } else {
    // No confirm step: whatever went last is the call that committed.
    steps[steps.length - 1].commits = true;
  }

  return steps;
}

/**
 * Thread the batch id returned by the head call through the later steps.
 *
 * Kept separate from buildSteps so that step construction stays pure and the
 * id, which only exists at runtime, is applied where it is known.
 */
export function applyBatchId(config: VoucherPosterConfig, steps: PostingStep[], batchId: string): void {
  for (const step of steps) {
    const field =
      step.kind === "line"
        ? config.line.fields.batchId
        : step.kind === "confirm"
          ? config.confirm?.fields.batchId
          : undefined;
    if (field) step.params[field] = batchId;
  }
}
