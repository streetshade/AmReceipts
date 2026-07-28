import { prisma } from "../db";
import { parseToCents } from "../money";
import { cacheProductImage } from "../productImages";
import { enqueuePendingLookup, clearPendingLookup } from "../pendingLookups";

export interface ProductInfo {
  barcode: string;
  name: string;
  brand: string | null;
  imageUrl: string | null;
  category: string | null;
  price: number | null; // cents
  source: "local" | "online";
}

// A lookup either resolves to a product, finds nothing, or is deferred because
// the upcitemdb daily limit was reached (rateLimited). Callers distinguish the
// last case to inform the user and rely on the 24h retry queue.
export interface LookupResult {
  product: ProductInfo | null;
  rateLimited: boolean;
}

export interface BarcodeProvider {
  readonly name: string;
  lookup(barcode: string): Promise<LookupResult>;
}

function normalize(barcode: string): string {
  return barcode.replace(/\s+/g, "").trim();
}

/** Looks the barcode up in our seeded Product table. */
async function lookupLocal(barcode: string): Promise<ProductInfo | null> {
  const p = await prisma.product.findUnique({ where: { barcode } });
  if (!p) return null;
  return {
    barcode: p.barcode,
    name: p.name,
    brand: p.brand,
    imageUrl: p.imageUrl,
    category: p.category,
    price: p.price,
    source: "local",
  };
}

class LocalBarcodeProvider implements BarcodeProvider {
  readonly name = "local";
  async lookup(barcode: string): Promise<LookupResult> {
    return { product: await lookupLocal(normalize(barcode)), rateLimited: false };
  }
}

// upcitemdb signals quota problems with HTTP 429 and/or a body code like
// EXCEED_LIMIT / TOO_FAST. Treat any of these as "rate limited → defer".
function isRateLimited(status: number, code?: string): boolean {
  if (status === 429) return true;
  return Boolean(code && /LIMIT|EXCEED|TOO_FAST/i.test(code));
}

/**
 * Online lookup via upcitemdb's trial endpoint (100 lookups/day, keyless),
 * falling back to the local DB. Products found online are cached locally so the
 * catalogue grows over time. When the daily limit is hit, the lookup fails
 * gracefully and the barcode is queued for a retry ~24h later.
 */
class UpcItemDbProvider implements BarcodeProvider {
  readonly name = "upcitemdb";

  async lookup(barcodeRaw: string): Promise<LookupResult> {
    const barcode = normalize(barcodeRaw);
    const local = await lookupLocal(barcode);
    if (local) return { product: local, rateLimited: false };

    try {
      const res = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(barcode)}`, {
        headers: { Accept: "application/json" },
        // Never hang the request path on a slow third party.
        signal: AbortSignal.timeout(6000),
      });

      const data = (await res.json().catch(() => ({}))) as {
        items?: Array<Record<string, any>>;
        code?: string;
      };

      if (isRateLimited(res.status, data.code)) {
        // Daily quota exhausted — defer and retry in 24h.
        await enqueuePendingLookup(barcode, data.code || `http_${res.status}`);
        return { product: null, rateLimited: true };
      }
      if (!res.ok) return { product: null, rateLimited: false };

      const item = data.items?.[0];
      if (!item) {
        // Genuinely nothing online; make sure it isn't left queued.
        await clearPendingLookup(barcode);
        return { product: null, rateLimited: false };
      }

      const info: ProductInfo = {
        barcode,
        name: item.title || `Item ${barcode}`,
        brand: item.brand || null,
        imageUrl: Array.isArray(item.images) && item.images.length ? item.images[0] : null,
        category: item.category || null,
        price: parseToCents(item.lowest_recorded_price ?? item.highest_recorded_price ?? null),
        source: "online",
      };

      // Download and store the image bytes locally, then persist the local path
      // (so the picture, like the product info, is served from the app on repeat use).
      info.imageUrl = await cacheProductImage(barcode, info.imageUrl);

      // Cache into the local catalogue for next time.
      await prisma.product.upsert({
        where: { barcode },
        update: { name: info.name, brand: info.brand, imageUrl: info.imageUrl, category: info.category, price: info.price },
        create: {
          barcode,
          name: info.name,
          brand: info.brand,
          imageUrl: info.imageUrl,
          category: info.category,
          price: info.price,
        },
      });

      // Resolved — clear any prior deferral.
      await clearPendingLookup(barcode);

      return { product: info, rateLimited: false };
    } catch {
      // Network/timeout/parse issues degrade gracefully to "not found".
      return { product: null, rateLimited: false };
    }
  }
}

export function getBarcodeProvider(): BarcodeProvider {
  const which = (process.env.BARCODE_PROVIDER || "local").toLowerCase();
  switch (which) {
    case "upcitemdb":
      return new UpcItemDbProvider();
    case "local":
    default:
      return new LocalBarcodeProvider();
  }
}
