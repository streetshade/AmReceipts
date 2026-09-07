// All monetary values are stored as integer cents to avoid floating-point drift.

/** Format integer cents as a currency string, e.g. 1299 -> "$12.99". */
export function formatCents(cents: number | null | undefined, currency = "USD"): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

/**
 * Parse a currency-ish string ("$12.99", "12.99", "1,299.00") to integer cents.
 *
 * Returns null for anything that is not yet a number - including a lone "-" or
 * "." mid-typing - so a partially typed value is never silently read as zero.
 */
export function parseToCents(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? centsFrom(value) : null;
  // Thousands separators and a currency symbol are stripped; anything else is
  // a rejection rather than a repair. Blind stripping turned "1e3" into "13"
  // and quietly stored 1300 cents.
  const cleaned = value.trim().replace(/[\s,$£€]/g, "");
  if (!/^-?\d*\.?\d*$/.test(cleaned)) return null;
  if (!/\d/.test(cleaned)) return null; // "", "-", ".", "-."
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  return centsFrom(num);
}

/**
 * Multiply by 100 without inheriting binary floating-point error.
 *
 * `Math.round(1.005 * 100)` is 100, not 101, because 1.005 is stored slightly
 * below its decimal value. Rounding the fixed-precision string first gives the
 * answer a person reading the receipt expects.
 */
function centsFrom(value: number): number | null {
  const cents = Math.round(Number((value * 100).toFixed(4)));
  // Beyond this, integer arithmetic stops being exact and the database column
  // would reject it anyway - better a refusal here than a 500 later.
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_CENTS) return null;
  // `-0` compares equal to 0 but serialises as "-0" and reads as a bug.
  return cents === 0 ? 0 : cents;
}

/** About ten billion in major units: far beyond any receipt, well inside Int. */
export const MAX_CENTS = 1_000_000_000_000;

/** Format integer cents for an editable field: no symbol, always two places. */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Sum a list of integer-cent amounts. */
export function sumCents(amounts: Array<number | null | undefined>): number {
  return amounts.reduce<number>((acc, a) => acc + (a ?? 0), 0);
}
