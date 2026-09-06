// Sales tax by region, for splitting a receipt's tax into its components.
//
// Why this exists: the office claims input tax credits on GST and HST but not
// on PST, so a single tax figure is not enough on a Canadian receipt - the
// parts have to be told apart. The same technician crosses the border in a
// day, so the split is decided per receipt from where it was issued.
//
// These rates are DEFAULTS, not truth. They are what the app fills in so the
// user does not have to; the receipt itself is the authority and the UI says
// so ("Read off the receipt - change it if it's wrong"). Rates change by
// legislation, and a rate that is quietly wrong for months is worse than one a
// user corrected on the day - so they live in one table, dated, rather than
// scattered through the code.
//
// LAST REVIEWED: not verified against current legislation. Treat every rate
// below as needing confirmation from finance before it is relied upon.

export type TaxCode = "GST" | "PST" | "QST" | "HST" | "SALES";

export interface TaxComponent {
  code: TaxCode;
  /** Basis points: 5% is 500. */
  rateBasisPoints: number;
  amount: number; // cents
}

interface RegionRule {
  label: string;
  /** Components charged, in the order they should be shown. */
  parts: { code: TaxCode; rateBasisPoints: number }[];
}

// Canada. Province code -> what is charged there.
const CANADA: Record<string, RegionRule> = {
  AB: { label: "Alberta", parts: [{ code: "GST", rateBasisPoints: 500 }] },
  BC: { label: "British Columbia", parts: [{ code: "GST", rateBasisPoints: 500 }, { code: "PST", rateBasisPoints: 700 }] },
  MB: { label: "Manitoba", parts: [{ code: "GST", rateBasisPoints: 500 }, { code: "PST", rateBasisPoints: 700 }] },
  NB: { label: "New Brunswick", parts: [{ code: "HST", rateBasisPoints: 1500 }] },
  NL: { label: "Newfoundland and Labrador", parts: [{ code: "HST", rateBasisPoints: 1500 }] },
  NS: { label: "Nova Scotia", parts: [{ code: "HST", rateBasisPoints: 1400 }] },
  NT: { label: "Northwest Territories", parts: [{ code: "GST", rateBasisPoints: 500 }] },
  NU: { label: "Nunavut", parts: [{ code: "GST", rateBasisPoints: 500 }] },
  ON: { label: "Ontario", parts: [{ code: "HST", rateBasisPoints: 1300 }] },
  PE: { label: "Prince Edward Island", parts: [{ code: "HST", rateBasisPoints: 1500 }] },
  QC: { label: "Quebec", parts: [{ code: "GST", rateBasisPoints: 500 }, { code: "QST", rateBasisPoints: 998 }] },
  SK: { label: "Saskatchewan", parts: [{ code: "GST", rateBasisPoints: 500 }, { code: "PST", rateBasisPoints: 600 }] },
  YT: { label: "Yukon", parts: [{ code: "GST", rateBasisPoints: 500 }] },
};

/** Regions we can split. The US is deliberately not enumerated - see below. */
export function regionsFor(country: string): { code: string; label: string }[] {
  if (country.toUpperCase() !== "CA") return [];
  return Object.entries(CANADA).map(([code, r]) => ({ code, label: r.label }));
}

/**
 * Split a receipt's tax total into its components.
 *
 * Apportioned by the RATIO of the statutory rates rather than recomputed from
 * the subtotal. The receipt's own total is the authority: recomputing would
 * produce a number that disagrees with the paper in the user's hand whenever a
 * merchant rounds differently or an item is zero-rated, and then the user is
 * asked to trust the app over the receipt.
 *
 * The largest component absorbs the rounding remainder, so the parts always sum
 * to exactly `taxTotalCents`.
 */
export function splitTax(country: string | null, region: string | null, taxTotalCents: number): TaxComponent[] {
  if (taxTotalCents === 0) return [];

  // Anything we do not have a rule for - the whole United States included -
  // is one line called "Sales tax". Enumerating US rates would mean thousands
  // of jurisdictions and a maintenance burden with no input-tax-credit payoff,
  // since the split only matters where some parts are reclaimable.
  const rule = country?.toUpperCase() === "CA" && region ? CANADA[region.toUpperCase()] : undefined;
  if (!rule) {
    return [{ code: "SALES", rateBasisPoints: 0, amount: taxTotalCents }];
  }
  if (rule.parts.length === 1) {
    const p = rule.parts[0];
    return [{ code: p.code, rateBasisPoints: p.rateBasisPoints, amount: taxTotalCents }];
  }

  const totalRate = rule.parts.reduce((s, p) => s + p.rateBasisPoints, 0);
  const raw = rule.parts.map((p) => (taxTotalCents * p.rateBasisPoints) / totalRate);
  const parts = raw.map(Math.floor);
  let remainder = taxTotalCents - parts.reduce((a, b) => a + b, 0);

  // To the biggest share first, so a stray penny lands where it is least
  // visible rather than on the smallest line.
  const order = raw.map((v, i) => ({ i, v })).sort((a, b) => b.v - a.v);
  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) parts[order[k].i]++;

  return rule.parts.map((p, i) => ({ code: p.code, rateBasisPoints: p.rateBasisPoints, amount: parts[i] }));
}

/** Human label for a tax line, e.g. "GST 5%". */
export function taxLabel(component: TaxComponent): string {
  if (component.rateBasisPoints === 0) return component.code === "SALES" ? "Sales tax" : component.code;
  const pct = component.rateBasisPoints / 100;
  // Trim a trailing .0 so 5% reads as "5%" and 9.975% keeps its precision.
  const shown = Number.isInteger(pct) ? String(pct) : String(Number(pct.toFixed(3)));
  return `${component.code} ${shown}%`;
}

/** Whether stored components still agree with the receipt's tax total. */
export function componentsBalance(components: { amount: number }[], taxTotalCents: number): boolean {
  return components.reduce((s, c) => s + c.amount, 0) === taxTotalCents;
}
