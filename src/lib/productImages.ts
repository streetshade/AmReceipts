import { promises as fs } from "fs";
import path from "path";

// Downloads a product image once and stores the bytes inside the app so repeat
// displays are served entirely locally (no dependency on the external CDN).
// Returns a local "/uploads/products/..." path on success, or the original
// remote URL as a fallback if the download isn't possible (so a picture still
// shows), or null if there was no image at all.

const DIR = path.join(process.cwd(), "public", "uploads", "products");
const MAX_BYTES = 5 * 1024 * 1024; // 5MB

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export async function cacheProductImage(barcode: string, remoteUrl: string | null): Promise<string | null> {
  if (!remoteUrl) return null;
  const safe = barcode.replace(/[^0-9A-Za-z]/g, "");
  if (!safe) return remoteUrl;

  try {
    const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return remoteUrl;

    const mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const ext = EXT_BY_MIME[mime];
    if (!ext) return remoteUrl; // not a recognized image type — keep the link

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) return remoteUrl;

    await fs.mkdir(DIR, { recursive: true });
    const filename = `${safe}.${ext}`;
    await fs.writeFile(path.join(DIR, filename), buf);
    return `/uploads/products/${filename}`;
  } catch {
    // Network/timeout/write failure — fall back to the remote URL so the image
    // still displays; it just isn't stored locally this time.
    return remoteUrl;
  }
}
