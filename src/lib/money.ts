// All monetary values are stored as integer cents to avoid floating-point drift.

/** Format integer cents as a currency string, e.g. 1299 -> "$12.99". */
export function formatCents(cents: number | null | undefined, currency = "USD"): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

/** Parse a currency-ish string ("$12.99", "12.99", "1,299.00") to integer cents. */
export function parseToCents(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Math.round(value * 100);
  const cleaned = value.replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const num = Number(cleaned);
  if (Number.isNaN(num)) return null;
  return Math.round(num * 100);
}

/** Sum a list of integer-cent amounts. */
export function sumCents(amounts: Array<number | null | undefined>): number {
  return amounts.reduce<number>((acc, a) => acc + (a ?? 0), 0);
}
