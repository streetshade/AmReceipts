import { prisma } from "../db";
import { parseToCents } from "../money";

export interface ProductInfo {
  barcode: string;
  name: string;
  brand: string | null;
  imageUrl: string | null;
  category: string | null;
  price: number | null; // cents
  source: "local" | "online";
}

export interface BarcodeProvider {
  readonly name: string;
  lookup(barcode: string): Promise<ProductInfo | null>;
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
  async lookup(barcode: string): Promise<ProductInfo | null> {
    return lookupLocal(normalize(barcode));
  }
}

/**
 * Online lookup via upcitemdb's trial endpoint (keyless at low volume), falling
 * back to the local DB. Any product found online is cached into the local DB so
 * it grows into a richer catalogue over time.
 */
class UpcItemDbProvider implements BarcodeProvider {
  readonly name = "upcitemdb";

  async lookup(barcodeRaw: string): Promise<ProductInfo | null> {
    const barcode = normalize(barcodeRaw);
    const local = await lookupLocal(barcode);
    if (local) return local;

    try {
      const res = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(barcode)}`, {
        headers: { Accept: "application/json" },
        // Never hang the request path on a slow third party.
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { items?: Array<Record<string, any>> };
      const item = data.items?.[0];
      if (!item) return null;

      const info: ProductInfo = {
        barcode,
        name: item.title || `Item ${barcode}`,
        brand: item.brand || null,
        imageUrl: Array.isArray(item.images) && item.images.length ? item.images[0] : null,
        category: item.category || null,
        price: parseToCents(item.lowest_recorded_price ?? item.highest_recorded_price ?? null),
        source: "online",
      };

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

      return info;
    } catch {
      // Network/timeout/parse issues degrade gracefully to "not found".
      return null;
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
