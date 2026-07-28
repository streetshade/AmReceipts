// Reconcile a scanned product against a receipt's line items.
// A scanned barcode's product name is fuzzily compared to each unlinked line
// item description; the best match above a threshold is linked.

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Jaccard-ish token overlap score in [0, 1]. */
export function similarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

export interface MatchCandidate {
  lineItemId: string;
  description: string;
}

/**
 * Returns the id of the best-matching, still-unlinked line item for a product
 * name, or null if nothing clears the threshold.
 */
export function bestLineItemMatch(
  productName: string,
  candidates: MatchCandidate[],
  threshold = 0.5,
): string | null {
  let bestId: string | null = null;
  let bestScore = threshold;
  for (const c of candidates) {
    const score = similarity(productName, c.description);
    if (score > bestScore) {
      bestScore = score;
      bestId = c.lineItemId;
    }
  }
  return bestId;
}
