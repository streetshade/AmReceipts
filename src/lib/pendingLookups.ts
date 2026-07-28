import { prisma } from "./db";

// Deferred-lookup queue. When upcitemdb's daily trial limit (100/day) is hit, a
// barcode lookup fails gracefully and the barcode is queued here to be retried
// ~24h later, once the quota resets.

const RETRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ATTEMPTS = 5; // stop retrying a barcode after this many deferrals

/** Queue (or re-queue) a barcode for a retry 24 hours from now. */
export async function enqueuePendingLookup(barcode: string, error = "rate_limited"): Promise<void> {
  const retryAfter = new Date(Date.now() + RETRY_MS);
  await prisma.pendingLookup.upsert({
    where: { barcode },
    update: { retryAfter, attempts: { increment: 1 }, lastError: error },
    create: { barcode, retryAfter, attempts: 1, lastError: error },
  });
}

/** Remove a barcode from the retry queue (e.g. once it resolves). */
export async function clearPendingLookup(barcode: string): Promise<void> {
  await prisma.pendingLookup.deleteMany({ where: { barcode } });
}

/** Whether a barcode is currently awaiting a deferred retry. */
export async function isPending(barcode: string): Promise<boolean> {
  return (await prisma.pendingLookup.count({ where: { barcode } })) > 0;
}

/**
 * Retry due deferred lookups. Called opportunistically on scans/lookups and by
 * the maintenance endpoint (for a cron). Non-blocking for callers.
 * On success the product is cached (by the provider) and any already-scanned
 * items for that barcode are backfilled with the product details.
 */
export async function retryDuePendingLookups(max = 5): Promise<{ processed: number; resolved: number }> {
  const due = await prisma.pendingLookup.findMany({
    where: { retryAfter: { lte: new Date() } },
    orderBy: { retryAfter: "asc" },
    take: max,
  });
  if (due.length === 0) return { processed: 0, resolved: 0 };

  // Lazy import avoids a module cycle (the provider imports this file).
  const { getBarcodeProvider } = await import("./providers/barcode");
  const provider = getBarcodeProvider();

  let resolved = 0;
  for (const item of due) {
    // The provider re-enqueues (bumps retryAfter) if still rate-limited, and
    // clears the queue entry on a successful online hit.
    const { product, rateLimited } = await provider.lookup(item.barcode);

    if (product) {
      // Resolved — dequeue and backfill any items scanned before it was known.
      // (The provider clears on an online hit; this also covers a local hit.)
      await clearPendingLookup(item.barcode);
      await backfillScannedItems(item.barcode, product.name);
      resolved++;
    } else if (!rateLimited) {
      // Genuinely not found online — stop retrying (or give up after N tries).
      await clearPendingLookup(item.barcode);
    } else if (item.attempts >= MAX_ATTEMPTS) {
      await clearPendingLookup(item.barcode);
    }
  }
  return { processed: due.length, resolved };
}

/** Link and rename any scanned items that were recorded before the product resolved. */
async function backfillScannedItems(barcode: string, name: string): Promise<void> {
  const product = await prisma.product.findUnique({ where: { barcode } });
  if (!product) return;
  await prisma.scannedItem.updateMany({
    where: { barcode, productId: null },
    data: { productId: product.id, name },
  });
}
