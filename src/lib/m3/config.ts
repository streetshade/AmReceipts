// Configuration schemas for the on-prem Infor M3 / ION API integration.
//
// The design separates three concerns that are easy to conflate:
//
//   1. CONNECTION  - how we reach ION API (credentials, tenant, environment).
//   2. BINDING     - which M3 company/division/supplier an AmReceipts user maps to.
//   3. ROUTING     - which accounting string an expense is booked against, and
//                    which kind of document carries it (AP invoice vs GL journal).
//
// Only (1) holds secrets. (2) and (3) are business configuration and live in
// their own tables so they can be ordered, validated against M3 and audited.
//
// Guiding rule throughout: make invalid states unrepresentable at config time.
// A ledger posting that fails at 02:00 in a batch is far more expensive than a
// rule an admin could not save in the first place.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Accounting dimensions
// ---------------------------------------------------------------------------

// M3 books against seven accounting dimensions (AIT1..AIT7). AIT1 is
// conventionally the GL account; the meaning of AIT2..AIT7 differs per
// installation, so their labels are configuration rather than constants.
export const DIMENSION_IDS = ["1", "2", "3", "4", "5", "6", "7"] as const;
export type DimensionId = (typeof DIMENSION_IDS)[number];

// Tokens usable in place of a literal dimension value. Resolution is strict: an
// unresolved token fails the rule and falls through to the next, rather than
// posting a literal "{{job.number}}" into the ledger.
export const ROUTING_TOKENS = [
  "{{job.number}}",
  "{{user.groupCode}}",
  "{{user.costCentre}}",
  "{{session.reasonType}}",
  "{{company.divi}}",
] as const;
export type RoutingToken = (typeof ROUTING_TOKENS)[number];

const TOKEN_SET: ReadonlySet<string> = new Set(ROUTING_TOKENS);

// A dimension value is either a whole known token or a literal. Mixing the two
// ("J{{job.number}}") is rejected: partial interpolation is where silent
// mis-postings come from, and M3 dimension values are short enough that a
// concatenated form is almost always a modelling mistake.
//
// The 24-character cap is a sanity bound only, and it is currently the ONLY
// check: real per-dimension lengths, code shapes, blocked flags and validity
// dates are installation-controlled and are not yet validated anywhere. An
// earlier version of this comment pointed at a ./master-data module that was
// never written. Until it is, a rule can name an account that M3 will reject -
// or worse, one that is blocked or out of its validity window on the posting
// date, which fails at posting time rather than when the rule is saved.
const DimensionValue = z
  .string()
  .trim()
  .min(1, "Dimension value cannot be empty")
  .max(24)
  .superRefine((v, ctx) => {
    if (!v.includes("{{") && !v.includes("}}")) return; // plain literal
    if (TOKEN_SET.has(v)) return; // whole, known token
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Must be a literal or exactly one of: ${ROUTING_TOKENS.join(", ")}`,
    });
  });

export const AccountingString = z.object({
  "1": DimensionValue, // GL account - always required, the rest are optional
  "2": DimensionValue.optional(),
  "3": DimensionValue.optional(),
  "4": DimensionValue.optional(),
  "5": DimensionValue.optional(),
  "6": DimensionValue.optional(),
  "7": DimensionValue.optional(),
});
export type AccountingString = z.infer<typeof AccountingString>;

// A partial accounting string: what a single routing rule contributes. Rules
// are merged in precedence order, so a merchant rule can set the account while
// a company default supplies the cost centre.
export const PartialAccountingString = AccountingString.partial();
export type PartialAccountingString = z.infer<typeof PartialAccountingString>;

// ---------------------------------------------------------------------------
// 1. Connection
// ---------------------------------------------------------------------------

// Shaped against a WORKING on-prem deployment (an existing internal M3 client,
// which reads and writes a live grid), not the ION API multi-tenant gateway.
// The difference is substantive: that setup calls m3api-rest directly on the
// grid and takes its bearer token from Infor STS, so there is no tenant
// segment, no /M3/m3api-rest/v2 path, and no tenantId anywhere.
//
//   baseUrl   https://<grid-host>:7443/infor/M3/m3api-rest
//   tokenUrl  https://<grid-host>:2443/InforIntSTS/connect/token
//
// Credentials map straight out of a backend-service .ionapi file:
//   ci -> clientId, cs -> client secret, saak -> username, sask -> password,
//   pu + ot -> tokenUrl.

// Trailing slash is stripped so callers can concatenate paths the way the
// reference client's rtrim() does. Userinfo, query and fragment are rejected:
// none is meaningful on these endpoints, and credentials in a URL end up in
// access logs.
const HttpsUrl = z
  .string()
  .url()
  .superRefine((u, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return; // .url() already reported this
    }
    if (parsed.protocol !== "https:") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "M3 endpoints must use https" });
    }
    if (parsed.username || parsed.password) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Credentials must not appear in the URL" });
    }
    if (parsed.search || parsed.hash) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Query string and fragment are not allowed here" });
    }
  })
  .transform((u) => u.replace(/\/+$/, ""));

// The secret blob behind `secretRef`. Never persisted by this app - parsed
// straight out of the environment at call time. Shapes differ by auth mode,
// so the resolver validates against the matching branch.
export const M3Secrets = z.discriminatedUnion("authMode", [
  z.object({
    authMode: z.literal("oauth_password"),
    cs: z.string().min(1),   // .ionapi client secret
    saak: z.string().min(1), // service account access key -> username
    sask: z.string().min(1), // service account secret key -> password
  }),
  z.object({
    authMode: z.literal("basic"),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
]);
export type M3Secrets = z.infer<typeof M3Secrets>;

// Records a single MI list call may return. MUST be positive: in m3api-rest 0
// (or negative) means "unbounded", which makes the grid materialise a whole
// result set in one transaction - a documented cause of M3 memory spikes on
// this grid family. The grid also enforces its own per-call ceiling (1000
// observed) with no offset to page past it, so bulk reads must be partitioned
// by key rather than paged, and a result of exactly maxrecs must be treated as
// possibly truncated rather than complete.
const MAXRECS_DEFAULT = 1000;

const ConnectionBase = {
  // m3api-rest root, including the /infor/M3 prefix this grid family uses.
  baseUrl: HttpsUrl,

  // Name of the env var holding the M3Secrets JSON blob.
  secretRef: z.string().min(1).default("M3_ION_SECRETS"),

  // Which M3 instance this points at. Guards posting - see `armed`.
  environment: z.enum(["DEV", "TST", "PRD"]),

  // Posting is refused unless BOTH dryRun is false AND armed is true. Two
  // flags rather than one so that enabling the integration can never, by
  // itself, start writing vouchers into a production ledger.
  dryRun: z.boolean().default(true),
  armed: z.boolean().default(false),

  // Company injected into every MI call when a caller does not supply one,
  // mirroring the reference client's m3.cono. Blank means "use the service
  // account's default company". Company bindings remain authoritative for
  // routing; this is only the transport-level fallback.
  defaultCono: z.string().regex(/^\d{1,3}$/).optional(),

  // Test grids commonly run on self-signed certificates. Allowed there,
  // never in production - see the refinement below.
  verifyTls: z.boolean().default(true),

  maxrecs: z.number().int().min(1).max(10_000).default(MAXRECS_DEFAULT),

  requestTimeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  connectTimeoutMs: z.number().int().min(1000).max(60_000).default(10_000),

  // Retries apply to reads and token fetches ONLY. Writes are never retried
  // from here - see the idempotency note in docs/M3_ION_INTEGRATION.md. A
  // blind retry on a timed-out voucher post can duplicate the voucher, and
  // unlike PPS001MI/ConfirmLine (which SETS a date and is naturally
  // repeatable), a GL post APPENDS and is not.
  readMaxRetries: z.number().int().min(0).max(5).default(2),
};

// Discriminated on authMode so that tokenUrl and clientId are required at the
// TYPE level for OAuth, not merely checked at runtime. Consumers then never
// have to narrow an optional that validation has already guaranteed.
const OAuthConnection = z
  .object({
    ...ConnectionBase,
    // Production shape: OAuth2 password grant against Infor STS carrying
    // client_id/client_secret plus the saak/sask pair, then m3api-rest with
    // "Authorization: Bearer".
    authMode: z.literal("oauth_password"),
    tokenUrl: HttpsUrl,          // .ionapi pu + ot
    clientId: z.string().min(1), // .ionapi ci
  })
  .strict();

const BasicConnection = z
  .object({
    ...ConnectionBase,
    // Plain HTTP basic straight at m3api-rest. Local/simple grids only.
    authMode: z.literal("basic"),
  })
  .strict();

export const M3ConnectionConfig = z
  .discriminatedUnion("authMode", [OAuthConnection, BasicConnection])
  .superRefine((c, ctx) => {
    if (c.environment !== "PRD") return;
    if (c.authMode !== "oauth_password") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authMode"],
        message: "Production must use oauth_password, not basic auth",
      });
    }
    if (!c.verifyTls) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verifyTls"],
        message: "TLS verification cannot be disabled against production",
      });
    }
  });
export type M3ConnectionConfig = z.infer<typeof M3ConnectionConfig>;

/**
 * Check a parsed connection against the deployment's production host
 * allowlist.
 *
 * This is deliberately NOT a field on the schema. An `environment` label is a
 * string an admin typed, and an allowlist an admin can edit alongside the
 * baseUrl attests nothing. The allowlist must arrive from trusted deployment
 * configuration (an env var read server-side), so the admin console can never
 * widen its own guard rails.
 *
 * Entries are compared against URL.host, so they must include the port where
 * one is used - e.g. "m3-grid-prod.example.com:7443".
 *
 * Returns [] when the connection is acceptable, else the reasons it is not.
 */
export function checkProductionHost(
  config: M3ConnectionConfig,
  prodHostAllowlist: readonly string[],
): string[] {
  let host: string;
  try {
    host = new URL(config.baseUrl).host;
  } catch {
    return ["baseUrl is not a valid URL"];
  }

  const listed = prodHostAllowlist.includes(host);
  const problems: string[] = [];

  // Deliberately strict: an empty allowlist fails a PRD config rather than
  // waving it through. A guard that switches itself off when unconfigured is
  // exactly the guard that is missing on the day it is needed.
  if (config.environment === "PRD" && !listed) {
    problems.push(
      prodHostAllowlist.length === 0
        ? "A PRD connection requires a deploy-time production host allowlist"
        : `Host ${host} is not in the production allowlist`,
    );
  }
  if (config.environment !== "PRD" && listed) {
    problems.push(
      `Host ${host} is a production host but this connection is labelled ${config.environment}`,
    );
  }
  return problems;
}

/**
 * The one entry point for turning stored JSON into a usable connection.
 *
 * Parsing and the production-host check are deliberately fused: splitting them
 * left a guard a caller could simply forget, which is the same failure mode as
 * not having the guard at all. Nothing else should call
 * `M3ConnectionConfig.parse` directly.
 *
 * `prodHostAllowlist` must come from deployment configuration read server-side,
 * never from the admin console.
 */
export function parseConnection(
  raw: unknown,
  prodHostAllowlist: readonly string[],
): { ok: true; config: M3ConnectionConfig } | { ok: false; errors: string[] } {
  const parsed = M3ConnectionConfig.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) =>
        i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message,
      ),
    };
  }

  const hostProblems = checkProductionHost(parsed.data, prodHostAllowlist);
  if (hostProblems.length > 0) {
    return { ok: false, errors: hostProblems };
  }

  return { ok: true, config: parsed.data };
}

// ---------------------------------------------------------------------------
// 2. Company binding
// ---------------------------------------------------------------------------

// What happens when no rule produces a complete accounting string.
export const SuspensePolicy = z.enum([
  // Hold the expense out of the batch and raise it for an admin. Correct
  // default: a routing gap is a configuration defect, and posting it anyway
  // converts that defect into accounting cleanup someone must chase later.
  "block",
  // Post to the suspense account and flag it. Only sensible with a monitored
  // queue and a low `suspenseLimitCents`.
  "post_and_flag",
]);
export type SuspensePolicy = z.infer<typeof SuspensePolicy>;

// AmReceipts identifies employers with a free-text `User.company`, which is far
// too loose to drive ledger postings. Binding is therefore explicit: an
// AmReceipts group (or company string) is mapped to an M3 company/division by
// an admin, and expenses from unmapped users are held rather than guessed.
export const M3CompanyBinding = z
  .object({
    // Exactly one of these identifies the AmReceipts side of the binding.
    // Allowing both would make two bindings able to claim the same user.
    amGroupId: z.string().min(1).nullable(),
    amCompany: z.string().min(1).nullable(),

    cono: z.number().int().min(1).max(999), // M3 company
    divi: z.string().length(3),             // M3 division
    currency: z.string().length(3),         // ISO 4217, e.g. "GBP"

    // Human labels for the dimensions as this company uses them, shown in the
    // rule editor. Keys are dimension ids; AIT1 defaults to "Account".
    dimensionLabels: z.record(z.enum(DIMENSION_IDS), z.string().min(1)).default({}),

    suspensePolicy: SuspensePolicy.default("block"),
    // Required only when the policy actually posts to suspense.
    suspenseAccount: z.string().min(1).optional(),
    // Above this per-session amount, always block rather than post to suspense.
    suspenseLimitCents: z.number().int().min(0).default(0),
  })
  .superRefine((b, ctx) => {
    const bound = [b.amGroupId, b.amCompany].filter((v) => v !== null).length;
    if (bound !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amGroupId"],
        message: "Set exactly one of amGroupId or amCompany",
      });
    }
    if (b.suspensePolicy === "post_and_flag" && !b.suspenseAccount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["suspenseAccount"],
        message: "post_and_flag requires a suspenseAccount",
      });
    }
  });
export type M3CompanyBinding = z.infer<typeof M3CompanyBinding>;

// Per-employee identifiers needed to raise a reimbursement. At least one must
// be present, or the claimant has no payable identity in M3 and an AP posting
// would fail at the gateway rather than in the admin console.
export const M3EmployeeBinding = z
  .object({
    userId: z.string().min(1),
    // M3 supplier number the employee is paid through (supplier master).
    supplierNo: z.string().min(1).nullable(),
    // M3 employee number, where payroll-side reimbursement is used instead.
    employeeNo: z.string().min(1).nullable(),
  })
  .refine((b) => Boolean(b.supplierNo || b.employeeNo), {
    message: "An employee binding needs a supplierNo or an employeeNo",
    path: ["supplierNo"],
  });
export type M3EmployeeBinding = z.infer<typeof M3EmployeeBinding>;

// ---------------------------------------------------------------------------
// 3a. Posting profiles - the "how was it paid" axis
// ---------------------------------------------------------------------------

// What kind of M3 document carries the expense. The credit side of the posting
// is decided here; the debit side comes from the routing rules below.
//
// Modelled as a discriminated union so an AP profile cannot carry a credit
// account and a GL profile cannot carry supplier settings.
const PostingProfileBase = {
  key: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().min(1),

  // FAM function driving M3's own accounting rules. Codes are configurable per
  // company - read them from the target installation rather than assuming.
  famFunction: z.string().min(1),
  // Voucher number series the document is drawn from.
  voucherSeries: z.string().min(1),

  // Default VAT handling. Rules may override per expense category.
  defaultVatCode: z.string().min(1).optional(),
  // Where tax cannot be reclaimed (no VAT receipt, entertainment), book the
  // gross amount to the expense account instead of splitting out the tax.
  reclaimTax: z.boolean().default(true),
};

// NOTE: Zod 3's discriminatedUnion accepts only ZodObject options. Calling
// .refine() on a branch yields a ZodEffects, which fails to typecheck and
// throws at construction ("could not be extracted"). Cross-field checks
// therefore hang off the union itself, not off its branches.
const ApInvoiceProfile = z
  .object({
    ...PostingProfileBase,
    document: z.literal("ap_invoice"),
    // Whose supplier account is credited.
    //   "employee" - the claimant, via M3EmployeeBinding
    //   "fixed"    - a single supplier (e.g. the card issuer)
    supplierSource: z.enum(["employee", "fixed"]),
    fixedSupplierNo: z.string().min(1).optional(),
  })
  .strict();

const GlJournalProfile = z
  .object({
    ...PostingProfileBase,
    document: z.literal("gl_journal"),
    creditAccount: z.string().min(1),
  })
  .strict();

export const M3PostingProfile = z
  .discriminatedUnion("document", [ApInvoiceProfile, GlJournalProfile])
  .superRefine((p, ctx) => {
    if (p.document !== "ap_invoice") return;
    if (p.supplierSource === "fixed" && !p.fixedSupplierNo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fixedSupplierNo"],
        message: "supplierSource 'fixed' requires fixedSupplierNo",
      });
    }
    if (p.supplierSource === "employee" && p.fixedSupplierNo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fixedSupplierNo"],
        message: "fixedSupplierNo is only valid with supplierSource 'fixed'",
      });
    }
  });
export type M3PostingProfile = z.infer<typeof M3PostingProfile>;

// ---------------------------------------------------------------------------
// 3b. Routing rules - the "what was bought, and why" axis
// ---------------------------------------------------------------------------

// Facts a rule can test, grouped by value type so that a condition cannot pair
// a boolean fact with a numeric operator. All are derivable from what
// AmReceipts already captures, except `expenseCategory`, which needs a new
// field on Receipt - merchant name alone is too weak a signal (a supermarket
// receipt may be catering, materials or welfare).
export const StringFact = z.enum([
  "merchant",        // Receipt.merchant, normalised (lowercased, trimmed)
  "expenseCategory", // proposed Receipt.expenseCategory
  "productCategory", // Product.category on a scanned item
  "reasonType",      // ExpenseSession.reasonType: job | travel | meeting
  "jobNumber",       // Job.number
  "userGroup",       // Group.name
  "userTitle",       // User.title
  "paymentType",     // PaymentMethod.type: card | cash | other
]);

export const NumberFact = z.enum([
  "amountCents",     // receipt or line total
]);

export const BooleanFact = z.enum([
  "hasJob",          // session assigned to a Job
  "isCompanyCard",   // payment method registered as a company card
  "hasTax",          // Receipt.tax > 0
]);

export type RuleFact =
  | z.infer<typeof StringFact>
  | z.infer<typeof NumberFact>
  | z.infer<typeof BooleanFact>;

// `matches` is anchored and length-bounded by the resolver. There is NO step
// budget - JavaScript offers none - so a pathological pattern can still be slow;
// the subject cap is what keeps it survivable. Prefer contains/starts_with/in,
// which cover nearly every real rule and cannot backtrack at all.
export const RuleCondition = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("string"),
    fact: StringFact,
    op: z.enum(["equals", "not_equals", "contains", "starts_with", "matches"]),
    value: z.string().min(1),
  }),
  z.object({
    kind: z.literal("stringSet"),
    fact: StringFact,
    op: z.enum(["in", "not_in"]),
    value: z.array(z.string().min(1)).min(1).max(200),
  }),
  z.object({
    kind: z.literal("number"),
    fact: NumberFact,
    op: z.enum(["equals", "gt", "gte", "lt", "lte"]),
    value: z.number().int(),
  }),
  z.object({
    kind: z.literal("boolean"),
    fact: BooleanFact,
    op: z.enum(["is_true", "is_false"]),
  }),
]);
export type RuleCondition = z.infer<typeof RuleCondition>;

// Rules are evaluated in ascending (precedence, id) - id breaks ties so the
// outcome never depends on database row order. Every matching rule merges its
// accounting fragment into the result, but a dimension already set by an
// earlier (more specific) rule is never overwritten. That gives specific rules
// the final say on the fields they care about while letting broad rules supply
// the remainder, without either needing to restate the other.
//
// Suggested precedence bands, leaving room to insert between them:
//    100  session-level override chosen by an approver
//    200  job / project derived
//    300  merchant specific
//    400  expense category
//    500  reason type (travel / meeting)
//    600  group or company default
//    900  catch-all -> suspense account
//
// Two rules may share a precedence (that is how an OR is expressed), but the
// admin console warns when same-precedence rules can both match and disagree on
// a dimension: that is an ambiguity the author should resolve, not a tie for
// the sort order to settle silently.
export const GlRoutingRule = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    precedence: z.number().int().min(0).max(1000),

    // Scope: null means every bound company.
    cono: z.number().int().nullable(),
    divi: z.string().length(3).nullable(),

    // All conditions must hold (AND). Model an OR by adding a second rule at
    // the same precedence - cheaper to read and to audit than nested groups.
    conditions: z.array(RuleCondition).max(12),

    // What this rule contributes. Values may be literals or routing tokens.
    accounting: PartialAccountingString,
    vatCode: z.string().min(1).optional(),

    // Force a posting profile regardless of payment method. Used sparingly -
    // e.g. routing all fuel to a fleet-card journal. First match by the same
    // (precedence, id) order wins; later rules do not override it.
    postingProfileKey: z.string().min(1).optional(),

    // Stop merging once this rule matches. Escape hatch for exceptions that
    // must not pick up company defaults - which means a terminal rule has to be
    // self-sufficient: if it ends evaluation, it must have supplied an account.
    terminal: z.boolean().default(false),
  })
  .superRefine((r, ctx) => {
    if (r.terminal && !r.accounting["1"]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["accounting", "1"],
        message: "A terminal rule must set the GL account (AIT1) itself",
      });
    }
    if (Object.keys(r.accounting).length === 0 && !r.vatCode && !r.postingProfileKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["accounting"],
        message: "Rule has no effect: set an accounting fragment, VAT code or posting profile",
      });
    }
  });
export type GlRoutingRule = z.infer<typeof GlRoutingRule>;

// ---------------------------------------------------------------------------
// Resolution result
// ---------------------------------------------------------------------------

// Returned by the resolver for one aggregated expense line. `trace` records
// which rules fired, so the admin dry-run screen can explain any posting - the
// difference between a rule engine people trust and one they work around.
//
// The union makes the unroutable case impossible to ignore: a caller cannot
// read `.accounting` without first checking `status`.
export const RoutingResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("routed"),
    accounting: AccountingString,
    vatCode: z.string().optional(),
    postingProfileKey: z.string(),
    // Carried through to the voucher so the poster never has to re-derive them.
    currency: z.string().length(3),
    amountCents: z.number().int(),
    taxCents: z.number().int(),
    accountingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    // True when the account came from the suspense fallback rather than a rule.
    viaSuspense: z.boolean(),
    trace: z.array(
      z.object({
        ruleId: z.string(),
        ruleName: z.string(),
        applied: z.array(z.enum(DIMENSION_IDS)),
        // Zod strips unknown keys, so the resolver's skip marker has to be
        // declared here or it is silently lost on the way through.
        skipped: z.literal("unresolved_token").optional(),
      }),
    ),
  }),
  z.object({
    status: z.literal("blocked"),
    // Why this expense cannot be posted, for the admin queue.
    reason: z.enum([
      "no_company_binding",
      "no_employee_binding",
      "no_matching_rule",
      "incomplete_accounting_string",
      "over_suspense_limit",
      "invalid_master_data",
      "period_closed",
    ]),
    detail: z.string(),
    trace: z.array(
      z.object({
        ruleId: z.string(),
        ruleName: z.string(),
        applied: z.array(z.enum(DIMENSION_IDS)),
        // Zod strips unknown keys, so the resolver's skip marker has to be
        // declared here or it is silently lost on the way through.
        skipped: z.literal("unresolved_token").optional(),
      }),
    ),
  }),
]);
export type RoutingResult = z.infer<typeof RoutingResult>;

// ---------------------------------------------------------------------------
// The business configuration as a whole
// ---------------------------------------------------------------------------

/**
 * A company card, matched against PaymentMethod's brand and last4.
 *
 * Spend on one of these is already paid: the liability sits on a card clearing
 * account, so it belongs in a journal, not an AP reimbursement. Everything else
 * is money an employee is owed.
 */
export const CompanyCard = z.object({
  brand: z.string().min(1),
  last4: z.string().regex(/^\d{4}$/),
  /** Posting profile to use for this card, overriding the default. */
  postingProfileKey: z.string().min(1).optional(),
});
export type CompanyCard = z.infer<typeof CompanyCard>;

export const M3BusinessConfig = z
  .object({
    companyBindings: z.array(M3CompanyBinding).default([]),
    postingProfiles: z.array(M3PostingProfile).default([]),
    routingRules: z.array(GlRoutingRule).default([]),
    companyCards: z.array(CompanyCard).default([]),

    /** Profile used when nothing else selects one. Usually the reimbursement one. */
    defaultProfileKey: z.string().min(1),
    /** Profile for spend on a registered company card. */
    companyCardProfileKey: z.string().min(1).optional(),
  })
  .superRefine((cfg, ctx) => {
    const keys = new Set(cfg.postingProfiles.map((p) => p.key));

    // A dangling profile key fails at posting time otherwise - after approval,
    // in a batch, where it reads as an outage rather than a typo.
    const check = (key: string | undefined, path: (string | number)[]) => {
      if (key && !keys.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `Unknown posting profile "${key}"` });
      }
    };
    check(cfg.defaultProfileKey, ["defaultProfileKey"]);
    check(cfg.companyCardProfileKey, ["companyCardProfileKey"]);
    cfg.companyCards.forEach((c, i) => check(c.postingProfileKey, ["companyCards", i, "postingProfileKey"]));
    cfg.routingRules.forEach((r, i) => check(r.postingProfileKey, ["routingRules", i, "postingProfileKey"]));

    if (cfg.postingProfiles.length !== keys.size) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["postingProfiles"],
        message: "Posting profile keys must be unique",
      });
    }

    const ruleIds = new Set(cfg.routingRules.map((r) => r.id));
    if (cfg.routingRules.length !== ruleIds.size) {
      // Ids break precedence ties, so duplicates would make ordering - and
      // therefore the resolved account - non-deterministic.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["routingRules"],
        message: "Routing rule ids must be unique",
      });
    }
  });
export type M3BusinessConfig = z.infer<typeof M3BusinessConfig>;
