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
  ".pdf": "application/pdf",
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

    const headers: Record<string, string> = {
      "Content-Type": type,
      "Cache-Control": "public, max-age=2592000, immutable",
      // Never let a browser second-guess the type we chose.
      "X-Content-Type-Options": "nosniff",
    };

    // PDFs are an ACTIVE format: they can carry JavaScript and reach for remote
    // resources. These files are uploaded by users and served from the app's
    // own origin, so rendering one inline would run its script against a
    // logged-in session. Force a download, and neutralise it on the way out.
    if (ext === ".pdf") {
      headers["Content-Disposition"] = `attachment; filename="${path.basename(target)}"`;
      headers["Content-Security-Policy"] = "sandbox; default-src 'none'";
    }

    return new Response(new Uint8Array(data), { headers });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
