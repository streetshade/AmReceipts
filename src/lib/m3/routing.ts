// The GL routing rule engine.
//
// Turns "what was bought, and why" into an M3 accounting string. Pure: no I/O,
// no database, no clock. That is deliberate — routing decisions have to be
// explainable months later, and a function whose output depends only on its
// arguments can be replayed exactly as it ran.
//
// The merge model: rules are evaluated in ascending (precedence, id), and every
// matching rule contributes a PARTIAL accounting string. A dimension already
// set by an earlier, more specific rule is never overwritten. So a narrow rule
// ("Shell -> account 7210") and a broad one ("Field Services -> cost centre
// 4400") compose without either restating the other. First-write-wins applies
// per dimension independently, not to the string as a whole.

import {
  DIMENSION_IDS,
  type DimensionId,
  type GlRoutingRule,
  type RuleCondition,
  type AccountingString,
  type PartialAccountingString,
} from "./config";

/** Everything a rule may test. Assembled once per expense line. */
export interface ExpenseFacts {
  merchant: string | null;
  expenseCategory: string | null;
  productCategory: string | null;
  reasonType: string | null;
  jobNumber: string | null;
  userGroup: string | null;
  userTitle: string | null;
  paymentType: string | null;
  amountCents: number;
  hasJob: boolean;
  isCompanyCard: boolean;
  hasTax: boolean;
}

/** Values available to {{token}} interpolation. */
export interface RoutingContext {
  jobNumber: string | null;
  userGroupCode: string | null;
  userCostCentre: string | null;
  reasonType: string | null;
  divi: string;
}

export interface RuleTraceEntry {
  ruleId: string;
  ruleName: string;
  applied: DimensionId[];
  /**
   * Set when the rule's conditions matched but it contributed nothing because a
   * token had no value behind it. Without this, the trace cannot distinguish
   * "this rule did not apply" from "this rule should have applied and could
   * not" - which is precisely the question someone debugging a wrong account
   * is asking.
   */
  skipped?: "unresolved_token";
}

export type RoutingOutcome =
  | {
      status: "routed";
      accounting: AccountingString;
      vatCode?: string;
      postingProfileKey?: string;
      trace: RuleTraceEntry[];
    }
  | {
      status: "incomplete";
      /** What was gathered before giving up, for the admin's dry-run screen. */
      partial: PartialAccountingString;
      trace: RuleTraceEntry[];
    };

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

// Regex safety, stated honestly: this is MITIGATION, NOT A GUARANTEE.
//
// Node's engine backtracks, and there is no step budget to set from JavaScript.
// A pattern like (a?)+$ or (a|aa)+$ can still blow up, and the heuristic below
// does not catch those shapes. What the bounds do is make the blow-up small
// enough to be survivable: catastrophic backtracking is exponential in SUBJECT
// length, so a 120-character cap is the real protection, not the pattern check.
//
// Rules are admin-authored rather than user-supplied, so the threat is a
// mistake, not an attacker. But a stalled posting queue looks the same either
// way, and `contains` / `starts_with` / `in` cover almost every real rule.
// Prefer them; reach for `matches` only when nothing else will do.
const MAX_PATTERN_LENGTH = 120;
const MAX_SUBJECT_LENGTH = 120;
const NESTED_QUANTIFIER = /[*+?}]\s*\)\s*[*+{]/;

function safeMatch(pattern: string, subject: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return false;
  if (subject.length > MAX_SUBJECT_LENGTH) return false;
  if (NESTED_QUANTIFIER.test(pattern)) return false;
  try {
    // Anchored, as the schema documents: a rule says what a value IS, not what
    // it happens to contain. `contains` exists for the other intent.
    return new RegExp(`^(?:${pattern})$`, "i").test(subject);
  } catch {
    // An invalid pattern fails its rule rather than the whole posting.
    return false;
  }
}

function normalise(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}

export function evaluateCondition(condition: RuleCondition, facts: ExpenseFacts): boolean {
  switch (condition.kind) {
    case "string": {
      const actual = normalise(facts[condition.fact] as string | null);
      const expected = condition.value.trim().toLowerCase();
      // A missing fact matches nothing - except not_equals, where "absent" is
      // genuinely not equal to the value being excluded.
      if (actual === null) return condition.op === "not_equals";
      switch (condition.op) {
        case "equals":
          return actual === expected;
        case "not_equals":
          return actual !== expected;
        case "contains":
          return actual.includes(expected);
        case "starts_with":
          return actual.startsWith(expected);
        case "matches":
          return safeMatch(condition.value, actual);
      }
    }
    case "stringSet": {
      const actual = normalise(facts[condition.fact] as string | null);
      const set = condition.value.map((v) => v.trim().toLowerCase());
      if (actual === null) return condition.op === "not_in";
      return condition.op === "in" ? set.includes(actual) : !set.includes(actual);
    }
    case "number": {
      const actual = facts[condition.fact];
      switch (condition.op) {
        case "equals":
          return actual === condition.value;
        case "gt":
          return actual > condition.value;
        case "gte":
          return actual >= condition.value;
        case "lt":
          return actual < condition.value;
        case "lte":
          return actual <= condition.value;
      }
    }
    case "boolean": {
      const actual = facts[condition.fact];
      return condition.op === "is_true" ? actual : !actual;
    }
  }
}

// ---------------------------------------------------------------------------
// Token interpolation
// ---------------------------------------------------------------------------

/**
 * Resolve a dimension value, or null when a token has nothing behind it.
 *
 * Strict on purpose. A rule whose {{job.number}} cannot be resolved is skipped
 * entirely rather than contributing a blank or a literal "{{job.number}}" — the
 * schema rejects mixed literal/token values precisely so this can be an
 * all-or-nothing decision per value.
 */
export function resolveValue(value: string, ctx: RoutingContext): string | null {
  if (!value.startsWith("{{")) return value;

  // A token that resolves to "" or whitespace has NOT resolved. These come from
  // free-text database columns, and treating a blank as a value would put an
  // empty dimension into a ledger posting - which the schema forbids for a
  // literal and should equally forbid here.
  const blankToNull = (v: string | null) => {
    const trimmed = v?.trim() ?? "";
    return trimmed === "" ? null : trimmed;
  };

  switch (value) {
    case "{{job.number}}":
      return blankToNull(ctx.jobNumber);
    case "{{user.groupCode}}":
      return blankToNull(ctx.userGroupCode);
    case "{{user.costCentre}}":
      return blankToNull(ctx.userCostCentre);
    case "{{session.reasonType}}":
      return blankToNull(ctx.reasonType);
    case "{{company.divi}}":
      return blankToNull(ctx.divi);
    default:
      // Schema validation should have caught this; refuse rather than guess.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Rules in evaluation order: ascending precedence, id breaking ties. */
export function orderRules(rules: GlRoutingRule[]): GlRoutingRule[] {
  // Sorting by id as well as precedence means the outcome never depends on
  // database or JSON array order, which would otherwise make two same-
  // precedence rules resolve differently between environments.
  return [...rules].sort((a, b) => a.precedence - b.precedence || a.id.localeCompare(b.id));
}

export interface ResolveOptions {
  cono: number;
  divi: string;
}

/**
 * Resolve one expense line to an accounting string.
 *
 * Returns `incomplete` rather than throwing when no rule supplies an account:
 * the caller decides whether that blocks the posting or falls to a suspense
 * account, because that is a policy question (see SuspensePolicy), not a
 * routing one.
 */
export function resolveRouting(
  rules: GlRoutingRule[],
  facts: ExpenseFacts,
  ctx: RoutingContext,
  opts: ResolveOptions,
): RoutingOutcome {
  const accounting: Record<string, string> = {};
  const trace: RuleTraceEntry[] = [];
  let vatCode: string | undefined;
  let postingProfileKey: string | undefined;

  for (const rule of orderRules(rules)) {
    if (!rule.enabled) continue;
    // A null scope means "every bound company".
    if (rule.cono !== null && rule.cono !== opts.cono) continue;
    if (rule.divi !== null && rule.divi !== opts.divi) continue;
    if (!rule.conditions.every((c) => evaluateCondition(c, facts))) continue;

    // Resolve every value BEFORE applying any of them. A rule that can only
    // half-resolve must contribute nothing at all, or it would leave a
    // partially-applied accounting string that no rule ever intended.
    const resolved: Partial<Record<DimensionId, string>> = {};
    let resolvable = true;
    for (const dim of DIMENSION_IDS) {
      const raw = rule.accounting[dim];
      if (raw === undefined) continue;
      const value = resolveValue(raw, ctx);
      if (value === null) {
        resolvable = false;
        break;
      }
      resolved[dim] = value;
    }
    if (!resolvable) {
      trace.push({ ruleId: rule.id, ruleName: rule.name, applied: [], skipped: "unresolved_token" });
      continue;
    }

    const applied: DimensionId[] = [];
    for (const dim of DIMENSION_IDS) {
      const value = resolved[dim];
      // First write wins, per dimension: an earlier (more specific) rule has
      // already had its say about this one.
      if (value === undefined || accounting[dim] !== undefined) continue;
      accounting[dim] = value;
      applied.push(dim);
    }

    if (vatCode === undefined && rule.vatCode !== undefined) vatCode = rule.vatCode;
    if (postingProfileKey === undefined && rule.postingProfileKey !== undefined) {
      postingProfileKey = rule.postingProfileKey;
    }

    // Record the rule even when it applied nothing: "this rule matched but was
    // outranked on every dimension" is exactly what someone debugging an
    // unexpected account needs to see.
    trace.push({ ruleId: rule.id, ruleName: rule.name, applied });

    if (rule.terminal) break;
  }

  if (accounting["1"] === undefined) {
    return { status: "incomplete", partial: accounting as PartialAccountingString, trace };
  }

  return {
    status: "routed",
    accounting: accounting as AccountingString,
    vatCode,
    postingProfileKey,
    trace,
  };
}
