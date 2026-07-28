import { promises as fs } from "fs";
import path from "path";

// Serves uploaded files (receipt images, cached product images) from disk.
// In production nginx serves /uploads/ directly (see deploy/nginx-amreceipts.conf)
// and never hits this route; this handler makes the app self-contained when run
// without a reverse proxy (e.g. `next start` alone, where files written to
// public/ after startup aren't served by the static handler).

const ROOT = path.join(process.cwd(), "public", "uploads");

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export async function GET(_req: Request, { params }: { params: { path: string[] } }) {
  const rel = (params.path || []).join("/");
  const target = path.join(ROOT, rel);

  // Prevent path traversal: the resolved path must stay within ROOT.
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const data = await fs.readFile(target);
    const ext = path.extname(target).toLowerCase();
    const type = CONTENT_TYPES[ext] ?? "application/octet-stream";
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": type,
        "Cache-Control": "public, max-age=2592000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
