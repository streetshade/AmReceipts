import { timingSafeEqual } from "node:crypto";
import { handler, json, error } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth";
import { loadM3, canPost } from "@/lib/m3/connection";
import { drainPostingQueue } from "@/lib/m3/worker";

export const dynamic = "force-dynamic";

/**
 * Constant-time secret comparison.
 *
 * The existing maintenance endpoint uses `!==`, which leaks length and prefix
 * through timing. That is a defensible trade for a barcode-retry job; this
 * endpoint writes to a general ledger, so it is worth the extra few lines.
 */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so compare lengths separately -
  // the length of a secret is not the part worth protecting.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// POST /api/m3/postings/drain
//
// Drives the posting queue. Intended for a scheduled call, so approved expenses
// reach M3 without anyone watching, but also callable by a signed-in admin from
// the console for a manual run.
//
// Example crontab (every 15 minutes):
//   */15 * * * * curl -s -X POST -H "x-cron-secret: $CRON_SECRET" \
//     https://receipts.example.com/api/m3/postings/drain >/dev/null
export const POST = handler(async (req: Request) => {
  // No AUTH_SECRET fallback here, unlike the barcode-retry job. That fallback
  // would make the session-signing secret a credential that moves money, and
  // widen the blast radius of leaking it from "forge a login" to "post to the
  // ledger". This endpoint requires its own secret or an admin session.
  const secret = process.env.CRON_SECRET;
  const byCron = Boolean(secret) && secretMatches(req.headers.get("x-cron-secret"), secret as string);

  // An admin may also trigger a run by hand. Anyone else, cron secret or not,
  // has no business moving money.
  let actor = "cron";
  if (!byCron) {
    const user = await getCurrentUser();
    if (!user || !user.active || user.role !== "admin") return error("Forbidden", 403);
    actor = user.id;
  }

  const loaded = await loadM3();
  if (!loaded.ok) {
    // Deliberately inactive is a 200: a cron that pages nightly about a known
    // gap gets muted, and then real failures go unnoticed too. But somebody
    // enabling this and getting the config wrong is a 500 - a monitor must be
    // able to tell a chosen pause from a broken deployment.
    if (loaded.kind === "misconfigured") return error(loaded.reason, 500);
    return json({ ran: false, reason: loaded.reason, actor });
  }

  const permitted = canPost(loaded.connection);
  if (!permitted.allowed) return json({ ran: false, reason: permitted.reason, actor });

  const url = new URL(req.url);
  const max = Math.min(Math.max(Number(url.searchParams.get("max")) || 50, 1), 200);

  const result = await drainPostingQueue(loaded.client, loaded.poster, { max });
  return json({ ran: true, actor, environment: loaded.connection.environment, ...result });
});
