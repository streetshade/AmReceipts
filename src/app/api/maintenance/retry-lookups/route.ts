import { handler, json, error } from "@/lib/api";
import { retryDuePendingLookups } from "@/lib/pendingLookups";

export const dynamic = "force-dynamic";

// Drives the deferred-lookup retry queue. Intended for a scheduled call (cron)
// so deferred barcodes are retried promptly once their 24h window elapses, even
// with no user activity. Protected by a shared secret.
//
// Example crontab (hourly):
//   0 * * * * curl -s -X POST -H "x-cron-secret: $CRON_SECRET" \
//     https://receipts.example.com/api/maintenance/retry-lookups >/dev/null
export const POST = handler(async (req: Request) => {
  const secret = process.env.CRON_SECRET || process.env.AUTH_SECRET;
  const provided = req.headers.get("x-cron-secret");
  if (!secret || provided !== secret) return error("Forbidden", 403);

  // Larger batch than the opportunistic path since this runs off the hot path.
  const result = await retryDuePendingLookups(50);
  return json(result);
});
