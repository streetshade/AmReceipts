// Assembles a usable M3 client from stored configuration.
//
// The stored Integration.config holds only non-secret settings; credentials
// come from the environment via secretRef, and the production host allowlist
// comes from deployment. Nothing an admin can type in the console is trusted to
// decide whether this may write to a production ledger.

import { prisma } from "../db";
import { M3Client } from "./client";
import { parseConnection, type M3ConnectionConfig } from "./config";
import { VoucherPosterConfig } from "./voucherPoster";

export const M3_INTEGRATION_KEY = "m3_ion";

export type LoadResult =
  | { ok: true; client: M3Client; connection: M3ConnectionConfig; poster: VoucherPosterConfig }
  // "inactive" is a deliberate state (not set up, switched off) and is a normal
  // 200 for a cron. "misconfigured" means somebody enabled it and got it wrong,
  // which must surface as a failure - otherwise a monitor cannot tell a chosen
  // pause from a broken deployment, and a real outage hides behind a quiet 200.
  | { ok: false; kind: "inactive" | "misconfigured"; reason: string };

/** Hosts this deployment considers production, supplied out of band. */
function prodHostAllowlist(): string[] {
  return (process.env.M3_PROD_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

/**
 * Load the M3 integration, or explain why it is not usable.
 *
 * Returns a reason rather than throwing: "not configured yet" is the normal
 * state of this integration for now, and a cron endpoint should report that
 * calmly rather than page someone with a stack trace.
 */
export async function loadM3(): Promise<LoadResult> {
  const integration = await prisma.integration.findUnique({ where: { key: M3_INTEGRATION_KEY } });
  if (!integration) return { ok: false, kind: "inactive", reason: "M3 integration is not set up" };
  if (!integration.enabled) return { ok: false, kind: "inactive", reason: "M3 integration is disabled" };

  let raw: unknown;
  try {
    raw = JSON.parse(integration.config);
  } catch {
    return { ok: false, kind: "misconfigured", reason: "M3 integration config is not valid JSON" };
  }
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, kind: "misconfigured", reason: "M3 integration config must be an object" };
  }

  const { connection, voucherPoster } = raw as Record<string, unknown>;

  const parsed = parseConnection(connection, prodHostAllowlist());
  if (!parsed.ok) {
    return { ok: false, kind: "misconfigured", reason: `Connection config invalid: ${parsed.errors.join("; ")}` };
  }

  // Deliberately checked here rather than at the call site: an integration with
  // no voucher mapping is not "ready but idle", it is unusable, and saying so
  // once is better than discovering it per posting.
  const poster = VoucherPosterConfig.safeParse(voucherPoster);
  if (!poster.success) {
    const fields = poster.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return {
      ok: false,
      kind: "misconfigured",
      reason:
        "Voucher poster is not mapped for this grid. Discover the real MI names with " +
        `MRS001MI/LstTransactions and LstFields, then fill in voucherPoster. (${fields.join("; ")})`,
    };
  }

  return {
    ok: true,
    client: new M3Client(parsed.config),
    connection: parsed.config,
    poster: poster.data,
  };
}

/** Whether this connection is permitted to write. Both flags, plus not dry-run. */
export function canPost(connection: M3ConnectionConfig): { allowed: boolean; reason?: string } {
  if (connection.dryRun) return { allowed: false, reason: "Connection is in dry-run mode" };
  if (!connection.armed) return { allowed: false, reason: "Connection is not armed for posting" };
  return { allowed: true };
}
