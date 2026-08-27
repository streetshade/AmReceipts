// Turns an approved expense session into a document ready for the queue.
//
// This is where the two routing axes meet. Payment method decides the DOCUMENT
// and the credit side (reimburse the employee, or clear a company card);
// merchant, category, job and reason decide the DEBIT accounting string. They
// are resolved independently, which is what lets a new company card be added
// without touching a single GL rule.

import { prisma } from "../db";
import type { M3BusinessConfig, M3CompanyBinding, M3PostingProfile } from "./config";
import { resolveRouting, type ExpenseFacts, type RoutingContext, type RuleTraceEntry } from "./routing";
import type { PreparedLine, PreparedPosting } from "./posting";

export type BuildResult =
  | { ok: true; posting: PreparedPosting; warnings: string[] }
  // Mirrors RoutingResult's blocked reasons: a posting that cannot be built is
  // a configuration gap somebody must close, not a transient failure.
  | {
      ok: false;
      reason:
        | "not_approved"
        | "no_company_binding"
        | "no_employee_binding"
        | "no_matching_rule"
        | "no_posting_profile"
        | "conflicting_posting_profiles"
        | "inconsistent_receipt"
        | "nothing_to_post";
      detail: string;
    };

/** One expense before routing: a receipt line, or a whole receipt. */
interface RawExpense {
  receiptId: string;
  description: string;
  amountCents: number;
  taxCents: number;
  merchant: string | null;
  expenseCategory: string | null;
  productCategory: string | null;
  paymentType: string | null;
  paymentBrand: string | null;
  paymentLast4: string | null;
}

/**
 * Split `total` across `weights` so the parts are integers summing EXACTLY to
 * total. Largest-remainder method: floor everything, then hand the leftover
 * pennies to the lines with the biggest fractional parts.
 *
 * Used for receipt-level tax, which OCR gives us as one figure for the whole
 * receipt. Dropping it would understate reclaimable VAT on every itemised
 * receipt; putting it all on one line would misstate that line. Pro-rata
 * allocation is the standard treatment, and the exact-sum property is what
 * stops a voucher failing M3's balance check by a penny.
 */
export function apportion(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const magnitudes = weights.map((w) => Math.abs(w));
  const sum = magnitudes.reduce((a, b) => a + b, 0);
  if (total === 0) return weights.map(() => 0);
  if (sum === 0) {
    // Nothing to weight by, but the tax still exists and must reach the ledger.
    // Returning zeroes here silently dropped it. Put it all on the first line -
    // an odd-looking posting is recoverable; a missing one is not.
    return weights.map((_, i) => (i === 0 ? total : 0));
  }

  const raw = magnitudes.map((w) => (total * w) / sum);
  const parts = raw.map(Math.floor);
  let leftover = total - parts.reduce((a, b) => a + b, 0);

  const byFraction = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; leftover > 0 && k < byFraction.length; k++, leftover--) {
    parts[byFraction[k].i]++;
  }
  return parts;
}

function isCompanyCard(config: M3BusinessConfig, brand: string | null, last4: string | null) {
  if (!brand || !last4) return undefined;
  return config.companyCards.find(
    (c) => c.brand.toLowerCase() === brand.toLowerCase() && c.last4 === last4,
  );
}

/** The company binding for this user: by group first, then by company string. */
function bindingFor(
  config: M3BusinessConfig,
  groupId: string | null,
  company: string | null,
): M3CompanyBinding | undefined {
  // Group is checked first because it is an explicit admin decision, whereas
  // the company string is free text the user typed about themselves.
  const byGroup = groupId ? config.companyBindings.find((b) => b.amGroupId === groupId) : undefined;
  if (byGroup) return byGroup;
  if (!company) return undefined;
  return config.companyBindings.find(
    (b) => b.amCompany !== null && b.amCompany.toLowerCase() === company.trim().toLowerCase(),
  );
}

/**
 * Build the posting for one session.
 *
 * Returns a reason rather than throwing: every failure here is something an
 * admin can fix in configuration, and the caller records it against the session
 * so it shows up in the audit trail instead of a log nobody reads.
 */
export async function buildPostingForSession(
  sessionId: string,
  config: M3BusinessConfig,
): Promise<BuildResult> {
  const session = await prisma.expenseSession.findUnique({
    where: { id: sessionId },
    include: {
      job: true,
      user: { include: { group: true } },
      // Explicit ordering: without it the flattening order - and anything
      // derived from it - would depend on whatever the database returns.
      receipts: {
        orderBy: { createdAt: "asc" },
        include: {
          lineItems: { orderBy: { createdAt: "asc" } },
          paymentMethod: true,
        },
      },
    },
  });
  if (!session) return { ok: false, reason: "nothing_to_post", detail: "Session not found" };

  // Only approved spend reaches the ledger. Checked here as well as at the call
  // site: this function is the last gate before money moves.
  if (session.approvalStatus !== "approved") {
    return { ok: false, reason: "not_approved", detail: `Session is ${session.approvalStatus}` };
  }

  const binding = bindingFor(config, session.user.groupId, session.user.company);
  if (!binding) {
    return {
      ok: false,
      reason: "no_company_binding",
      detail: `No M3 company binding for ${session.user.group?.name ?? session.user.company ?? "this user"}`,
    };
  }

  // Flatten receipts into individual expenses. A receipt with line items is
  // routed line by line, because one shop trip can legitimately split across
  // several accounts; a receipt without them is routed as a single total.
  const expenses: RawExpense[] = [];
  for (const receipt of session.receipts) {
    const common = {
      receiptId: receipt.id,
      merchant: receipt.merchant,
      expenseCategory: receipt.expenseCategory,
      paymentType: receipt.paymentMethod?.type ?? null,
      paymentBrand: receipt.paymentMethod?.brand ?? null,
      paymentLast4: receipt.paymentMethod?.last4 ?? null,
    };
    const receiptTax = receipt.tax ?? 0;

    if (receipt.lineItems.length === 0) {
      // `|| receiptTax !== 0` because a receipt can total zero and still carry
      // tax (a fully discounted purchase, a correction), and that tax is real.
      if (receipt.total !== null && (receipt.total !== 0 || receiptTax !== 0)) {
        expenses.push({
          ...common,
          description: receipt.merchant ?? "Receipt",
          amountCents: receipt.total,
          taxCents: receiptTax,
          productCategory: null,
        });
      }
      continue;
    }

    const itemised = receipt.lineItems.reduce((sum, i) => sum + i.amount, 0);

    // A stated total at or below zero against positive line items is not a
    // discount, it is bad data. Posting it would net the lines to nothing or
    // go negative, so it is refused rather than quietly booked.
    if (receipt.total !== null && receipt.total <= 0 && itemised > 0) {
      return {
        ok: false,
        reason: "inconsistent_receipt",
        detail: `Receipt ${receipt.id} totals ${(receipt.total / 100).toFixed(2)} but its lines come to ${(itemised / 100).toFixed(2)}`,
      };
    }

    const parts: RawExpense[] = receipt.lineItems.map((item) => ({
      ...common,
      description: item.description,
      amountCents: item.amount,
      taxCents: 0,
      productCategory: null,
    }));

    // Anything the line items do not account for - service charge, rounding, a
    // line OCR could not read - still has to reach the ledger. A negative
    // remainder is a legitimate discount; only the total <= 0 case above is not.
    if (receipt.total !== null) {
      const remainder = receipt.total - itemised;
      if (remainder !== 0) {
        parts.push({
          ...common,
          description: remainder > 0 ? "Unitemised balance" : "Discount / adjustment",
          amountCents: remainder,
          taxCents: 0,
          productCategory: null,
        });
      }
    }

    // Receipt tax is a single OCR figure for the whole receipt, so it is spread
    // across the lines in proportion to their value. An earlier version zeroed
    // it on every item and only attached it to a remainder line, which silently
    // dropped the tax on any receipt whose lines happened to add up.
    const taxParts = apportion(receiptTax, parts.map((p) => p.amountCents));
    parts.forEach((part, i) => {
      part.taxCents = taxParts[i];
    });

    expenses.push(...parts);
  }

  if (expenses.length === 0) {
    return { ok: false, reason: "nothing_to_post", detail: "Session has no receipt amounts" };
  }

  const ctx: RoutingContext = {
    jobNumber: session.job?.number ?? null,
    userGroupCode: session.user.group?.name ?? null,
    userCostCentre: null,
    reasonType: session.reasonType,
    divi: binding.divi,
  };

  const warnings: string[] = [];

  // Accumulate by accounting string: a voucher wants one line per account, not
  // one per receipt line, and two coffees on the same account are one posting.
  const grouped = new Map<
    string,
    { line: Omit<PreparedLine, "lineNo">; rules: Set<string>; receipts: Set<string>; merged: number; base: string }
  >();

  // Every distinct posting profile the expenses call for. A session that mixes
  // company-card and personal spend needs two DIFFERENT documents with
  // different credit sides, and one posting cannot be both.
  const profileVotes = new Map<string, string>();

  const unregisteredCards = new Set<string>();

  for (const expense of expenses) {
    const card = isCompanyCard(config, expense.paymentBrand, expense.paymentLast4);

    // A card we do not recognise is treated as personal and reimbursed. That is
    // the safe default, but it is also how a company card gets paid twice if
    // somebody forgets to register it, so say so loudly.
    if (!card && expense.paymentType === "card" && expense.paymentBrand && expense.paymentLast4) {
      unregisteredCards.add(`${expense.paymentBrand} ****${expense.paymentLast4}`);
    }

    const facts: ExpenseFacts = {
      merchant: expense.merchant,
      expenseCategory: expense.expenseCategory,
      productCategory: expense.productCategory,
      reasonType: session.reasonType,
      jobNumber: session.job?.number ?? null,
      userGroup: session.user.group?.name ?? null,
      userTitle: session.user.title,
      paymentType: expense.paymentType,
      amountCents: expense.amountCents,
      hasJob: session.jobId !== null,
      isCompanyCard: card !== undefined,
      hasTax: expense.taxCents > 0,
    };

    const routed = resolveRouting(config.routingRules, facts, ctx, {
      cono: binding.cono,
      divi: binding.divi,
    });

    let accounting: Record<string, string | undefined>;
    let vatCode: string | undefined;
    let viaSuspense = false;
    const trace: RuleTraceEntry[] = routed.trace;

    if (routed.status === "routed") {
      accounting = routed.accounting;
      vatCode = routed.vatCode;
    } else if (binding.suspensePolicy === "post_and_flag" && binding.suspenseAccount) {
      // Policy decision, not a routing one: post it where an accountant can see
      // it rather than blocking the whole session.
      if (binding.suspenseLimitCents > 0 && expense.amountCents > binding.suspenseLimitCents) {
        return {
          ok: false,
          reason: "no_matching_rule",
          detail: `"${expense.description}" (${(expense.amountCents / 100).toFixed(2)}) has no routing rule and exceeds the suspense limit`,
        };
      }
      accounting = { "1": binding.suspenseAccount };
      viaSuspense = true;
      warnings.push(`"${expense.description}" fell through to the suspense account`);
    } else {
      return {
        ok: false,
        reason: "no_matching_rule",
        detail: `No routing rule produced an account for "${expense.description}"`,
      };
    }

    // Profile for THIS expense. Card selection is independent of the GL rules;
    // a rule override wins over the card, and the default catches the rest.
    const profileForExpense =
      (routed.status === "routed" ? routed.postingProfileKey : undefined) ??
      card?.postingProfileKey ??
      (card ? config.companyCardProfileKey : undefined) ??
      config.defaultProfileKey;
    if (!profileVotes.has(profileForExpense)) {
      profileVotes.set(profileForExpense, expense.description);
    }

    // JSON rather than a joined string: dimension values may legally contain a
    // separator character, and a collision here would merge two different
    // accounts into one voucher line. viaSuspense is part of the key because a
    // flagged fallback line must never be absorbed into a properly routed one.
    const key = JSON.stringify([
      accounting["1"], accounting["2"], accounting["3"], accounting["4"],
      accounting["5"], accounting["6"], accounting["7"], vatCode ?? null, viaSuspense,
    ]);

    const existing = grouped.get(key);
    if (existing) {
      existing.line.amountCents += expense.amountCents;
      existing.line.taxCents = (existing.line.taxCents ?? 0) + expense.taxCents;
      existing.merged++;
      trace.forEach((t) => existing.rules.add(t.ruleId));
      existing.receipts.add(expense.receiptId);
      // Rebuilt from the stored base each time. Rewriting the previous
      // description in place compounded, producing nested nonsense by the
      // third merge.
      existing.line.description = `${existing.base} + ${existing.merged} more`;
      // Once a line spans receipts it no longer belongs to one, and claiming
      // otherwise would send a reconciler to the wrong document.
      if (existing.receipts.size > 1) existing.line.receiptId = undefined;
    } else {
      grouped.set(key, {
        base: expense.description,
        merged: 0,
        receipts: new Set([expense.receiptId]),
        line: {
          dim1: accounting["1"] as string,
          dim2: accounting["2"],
          dim3: accounting["3"],
          dim4: accounting["4"],
          dim5: accounting["5"],
          dim6: accounting["6"],
          dim7: accounting["7"],
          amountCents: expense.amountCents,
          taxCents: expense.taxCents,
          vatCode,
          description: expense.description,
          receiptId: expense.receiptId,
          viaSuspense,
        },
        rules: new Set(trace.map((t) => t.ruleId)),
      });
    }
  }

  // Refuse rather than guess. Picking whichever profile the first expense
  // happened to want would reimburse an employee for spend already paid on a
  // company card, or vice versa - a real double payment.
  //
  // Named for the condition actually detected: profiles can also conflict
  // because two routing rules deliberately chose different ones, which is not
  // a payment-method problem at all.
  if (profileVotes.size > 1) {
    const which = [...profileVotes.entries()].map(([k, example]) => `${k} (e.g. "${example}")`);
    return {
      ok: false,
      reason: "conflicting_posting_profiles",
      detail:
        `This session needs more than one posting profile: ${which.join(", ")}. ` +
        "Split the spend into separate sessions, or adjust the rules so one profile applies.",
    };
  }

  for (const label of unregisteredCards) {
    warnings.push(`${label} is not a registered company card - treated as personal spend to reimburse`);
  }

  const profileKey = [...profileVotes.keys()][0];

  const chosenKey = profileKey ?? config.defaultProfileKey;
  const profile: M3PostingProfile | undefined = config.postingProfiles.find((p) => p.key === chosenKey);
  if (!profile) {
    return { ok: false, reason: "no_posting_profile", detail: `Posting profile "${chosenKey}" is not defined` };
  }

  // An AP reimbursement needs somebody to pay. Checked before enqueuing so the
  // gap surfaces as a clear configuration error rather than an MI rejection.
  let supplierNo: string | null = null;
  if (profile.document === "ap_invoice") {
    supplierNo =
      profile.supplierSource === "fixed"
        ? (profile.fixedSupplierNo ?? null)
        : session.user.m3SupplierNo;
    if (!supplierNo) {
      return {
        ok: false,
        reason: "no_employee_binding",
        detail: `${session.user.name} has no M3 supplier number for reimbursement`,
      };
    }
  }

  const lines: PreparedLine[] = [...grouped.values()].map((g, index) => ({
    ...g.line,
    lineNo: index + 1,
    routedBy: [...g.rules],
  }));

  return {
    ok: true,
    warnings,
    posting: {
      sessionId: session.id,
      userId: session.user.id,
      userName: session.user.name,
      userEmail: session.user.email,
      jobId: session.jobId,
      jobNumber: session.job?.number ?? null,
      jobName: session.job?.name ?? null,
      groupName: session.user.group?.name ?? null,
      cono: String(binding.cono),
      divi: binding.divi,
      currency: binding.currency,
      // The approval date is when the spend was authorised, which is the date
      // finance expects to see it hit the period.
      accountingDate: (session.approvedAt ?? session.createdAt).toISOString().slice(0, 10),
      postingProfileKey: profile.key,
      documentType: profile.document,
      supplierNo,
      lines,
    },
  };
}
