// M3 accounting master data: which dimension values actually exist, and when.
//
// This is the module the dimension-value comment in config.ts used to point at
// and which did not exist. Without it the only check on an accounting string
// was a length cap, so a rule could name a blocked account, an identity from
// another division, or one outside its validity window - and find out at
// posting time, in a batch, as an MI error someone has to decode.
//
// The shape mirrors an M3 accounting-identity export (CRS630 / the chart of
// accounts): identity, dimension, description, division scope, blocked flag,
// validity dates, currency. Populate it from MRS001MI or from that export; it
// is deliberately empty here, because a customer's chart of accounts is their
// data and does not belong in this repository.
//
// SCOPE NOTE. An M3 estate also carries cost-element and costing-control
// configuration - costing operators, PPS280 control fields, cost models. Those
// govern LANDED COST ON PURCHASE ORDERS, which is a different subsystem with
// different semantics. The only part that crosses over is the accounting
// control object vocabulary, because those codes ARE dimension values and so
// belong in this catalogue. The costing machinery deliberately is not modelled:
// borrowing it would put purchase-order pricing logic inside an expense
// connector, which is how integrations quietly become unmaintainable.

import { z } from "zod";
import { DIMENSION_IDS, type DimensionId, type AccountingString } from "./config";

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** One accounting identity, as M3 holds it. */
export const DimensionIdentity = z.object({
  dimension: z.enum(DIMENSION_IDS),
  /** The value as posted, e.g. an account number or a cost-centre code. */
  value: z.string().trim().min(1),
  description: z.string().default(""),
  /** Division this identity is scoped to. Null means every division. */
  divi: z.string().length(3).nullable().default(null),
  /** Blocked identities exist but may not be posted to. */
  blocked: z.boolean().default(false),
  validFrom: IsoDate.nullable().default(null),
  validTo: IsoDate.nullable().default(null),
  /** Restricts postings to this currency where set. */
  currency: z.string().length(3).nullable().default(null),
  /**
   * False for rollup/summary levels. The chart has a level 1/2/3 hierarchy and
   * a parent is not necessarily postable - but that must be stated, not
   * inferred from the level, because some charts do allow it.
   */
  postable: z.boolean().default(true),
});
export type DimensionIdentity = z.infer<typeof DimensionIdentity>;

export const DimensionCatalogue = z.object({
  /** When this snapshot was taken, so staleness is visible rather than assumed. */
  syncedAt: z.string().datetime().nullable().default(null),
  /**
   * Dimensions this snapshot covers COMPLETELY.
   *
   * Without this, a partial sync is indistinguishable from a complete one, and
   * every identity the sync happened to miss looks like an unknown code - so a
   * truncated import would reject perfectly good postings. A dimension absent
   * from this list is still checked for blocked/expired/division problems on
   * identities we do hold; it just cannot be judged for existence.
   */
  completeFor: z.array(z.enum(DIMENSION_IDS)).default([]),
  identities: z.array(DimensionIdentity).default([]),
});
export type DimensionCatalogue = z.infer<typeof DimensionCatalogue>;

export interface ValidationContext {
  divi: string;
  /** The date the voucher will be booked under - NOT today. */
  accountingDate: string;
  currency: string;
  enabledDimensions?: readonly DimensionId[];
}

export interface ValidationProblem {
  dimension: DimensionId;
  value: string;
  reason:
    | "unknown_identity"
    | "wrong_division"
    | "blocked"
    | "not_yet_valid"
    | "expired"
    | "not_postable"
    | "wrong_currency"
    | "dimension_disabled";
  detail: string;
}

/** Identities valid for a dimension in a division. Empty catalogue = no opinion. */
function candidates(cat: DimensionCatalogue, dim: DimensionId, value: string): DimensionIdentity[] {
  return cat.identities.filter((i) => i.dimension === dim && i.value === value);
}

/**
 * Check a resolved accounting string against the catalogue.
 *
 * Returns every problem rather than the first, so an admin fixing a rule sees
 * the whole picture instead of playing whack-a-mole.
 *
 * An EMPTY catalogue reports no IDENTITY problems - it must not block every
 * posting in a deployment that has not synced master data. Disabled-dimension
 * problems are still reported, because those come from the company binding
 * rather than the catalogue and are knowable without it.
 */
export function validateAccountingString(
  catalogue: DimensionCatalogue,
  accounting: Partial<Record<DimensionId, string>> | AccountingString,
  ctx: ValidationContext,
): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const enabled = ctx.enabledDimensions ?? DIMENSION_IDS;

  for (const dim of DIMENSION_IDS) {
    const value = (accounting as Record<string, string | undefined>)[dim];
    if (value === undefined || value === "") continue;

    if (!enabled.includes(dim)) {
      problems.push({ dimension: dim, value, reason: "dimension_disabled", detail: `AIT${dim} is not in use for this company` });
      continue;
    }
    if (catalogue.identities.length === 0) continue;

    const all = candidates(catalogue, dim, value);
    if (all.length === 0) {
      // Only an authority on existence where the snapshot claims completeness.
      if (!catalogue.completeFor.includes(dim)) continue;
      problems.push({ dimension: dim, value, reason: "unknown_identity", detail: `No AIT${dim} identity "${value}" in the catalogue` });
      continue;
    }

    // A value scoped to another division is not this division's value, even
    // though the code is identical - AIT2 codes in particular repeat across
    // sites and mean different things.
    const inDivision = all.filter((i) => i.divi === null || i.divi === ctx.divi);
    if (inDivision.length === 0) {
      problems.push({ dimension: dim, value, reason: "wrong_division", detail: `AIT${dim} "${value}" is not valid in division ${ctx.divi}` });
      continue;
    }

    // Any one usable identity is enough; report the clearest reason otherwise.
    const usable = inDivision.filter(
      (i) =>
        !i.blocked &&
        i.postable &&
        (i.validFrom === null || i.validFrom <= ctx.accountingDate) &&
        (i.validTo === null || i.validTo >= ctx.accountingDate) &&
        (i.currency === null || i.currency === ctx.currency),
    );
    if (usable.length > 0) continue;

    // Prefer the candidate that explains the failure best. Reporting
    // inDivision[0] blindly could say "restricted to null" while a duplicate
    // carried the real currency restriction.
    const first =
      inDivision.find((i) => i.blocked) ??
      inDivision.find((i) => !i.postable) ??
      inDivision.find((i) => i.validFrom !== null && i.validFrom > ctx.accountingDate) ??
      inDivision.find((i) => i.validTo !== null && i.validTo < ctx.accountingDate) ??
      inDivision.find((i) => i.currency !== null) ??
      inDivision[0];
    if (first.blocked) {
      problems.push({ dimension: dim, value, reason: "blocked", detail: `AIT${dim} "${value}" is blocked` });
    } else if (!first.postable) {
      problems.push({ dimension: dim, value, reason: "not_postable", detail: `AIT${dim} "${value}" is a summary level, not postable` });
    } else if (first.validFrom !== null && first.validFrom > ctx.accountingDate) {
      // Checked against the ACCOUNTING date, not today: a posting backdated
      // into a period before an account existed is exactly the error this is
      // here to catch.
      problems.push({ dimension: dim, value, reason: "not_yet_valid", detail: `AIT${dim} "${value}" is not valid until ${first.validFrom}` });
    } else if (first.validTo !== null && first.validTo < ctx.accountingDate) {
      problems.push({ dimension: dim, value, reason: "expired", detail: `AIT${dim} "${value}" expired on ${first.validTo}` });
    } else {
      problems.push({ dimension: dim, value, reason: "wrong_currency", detail: `AIT${dim} "${value}" is restricted to ${first.currency}, not ${ctx.currency}` });
    }
  }

  return problems;
}

export type CatalogueState = "missing" | "stale" | "fresh";

/**
 * Whether the catalogue is worth validating against, and how confidently.
 *
 * Three states rather than a boolean, because the earlier boolean failed OPEN:
 * once a snapshot passed its age limit, validation stopped entirely and known
 * blocked or expired accounts began sailing through with only a warning. A
 * month-old chart of accounts is usually still right, and is certainly better
 * than no checking at all - so `stale` still validates, and says so.
 */
export function catalogueState(catalogue: DimensionCatalogue, maxAgeDays = 30): CatalogueState {
  if (catalogue.identities.length === 0) return "missing";
  if (!catalogue.syncedAt) return "stale";
  const age = Date.now() - new Date(catalogue.syncedAt).getTime();
  return age < maxAgeDays * 24 * 60 * 60 * 1000 ? "fresh" : "stale";
}
