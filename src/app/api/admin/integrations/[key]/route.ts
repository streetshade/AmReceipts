import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireRole } from "@/lib/api";
import { integrationDef, secretFieldNames, INTEGRATIONS } from "@/lib/integrations/registry";
import { seal, open } from "@/lib/secretbox";

type Params = { params: { key: string } };

const Body = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.any()).optional(),
  // Only the secrets being CHANGED. An omitted secret keeps its stored value;
  // an explicit empty string clears it. Without that distinction there is no
  // way to save the form without re-typing every credential.
  secrets: z.record(z.string()).optional(),
  // The `updatedAt` the client loaded. Rejects a save built on a stale view
  // rather than silently overwriting whatever changed underneath it.
  expectedVersion: z.string().optional(),
  // Recovery: discard the stored credential blob entirely and start again.
  // Explicit rather than inferred from "every value is empty", which made a
  // single-field clear silently wipe everything, and left an unreadable vault
  // with no way out at all.
  clearAllSecrets: z.boolean().optional(),
});

// Config keys this app owns that the registry does not surface as form fields.
// Preserved across a console save so editing the form cannot destroy
// configuration written by other means.
const PRESERVED_CONFIG_KEYS = ["voucherPoster", "connection"];

/** Registry-validated view of a stored config: unknown keys stripped. */
function publicConfig(def: ReturnType<typeof integrationDef>, raw: unknown): Record<string, unknown> {
  if (!def) return {};
  const parsed = def.config.safeParse(raw ?? {});
  // Zod objects strip unknown keys, so parsing IS the redaction: anything that
  // found its way into the column by another route never reaches the browser.
  return parsed.success ? parsed.data : {};
}

/**
 * Admin: update an integration.
 *
 * Secrets are encrypted and never returned. The response reports which are set
 * so the console can show "configured" without ever holding the value.
 */
export const PATCH = handler(async (req: Request, { params }: Params) => {
  await requireRole("admin");

  const def = integrationDef(params.key);
  if (!def) return error("Unknown integration", 404);

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return error("Invalid input", 422);

  const allowedSecrets = new Set(secretFieldNames(def));
  const incomingSecrets = parsed.data.secrets;

  // A typo'd secret name must not be filtered away and reported as "Saved".
  if (incomingSecrets) {
    const unknown = Object.keys(incomingSecrets).filter((k) => !allowedSecrets.has(k));
    if (unknown.length > 0) return error(`Unknown secret field(s): ${unknown.join(", ")}`, 422);
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Read INSIDE the transaction. Reading first and writing later left a
      // window in which two concurrent saves could each disable the other and
      // then both enable themselves, leaving two active posting systems.
      const existing = await tx.integration.findUnique({ where: { key: params.key } });
      if (!existing) throw new HttpError("Integration not found", 404);

      if (parsed.data.expectedVersion && existing.updatedAt.toISOString() !== parsed.data.expectedVersion) {
        throw new HttpError("This integration was changed elsewhere. Reload and try again.", 409);
      }

      // --- config: merge over the validated view, preserving what we do not own
      let configJson = existing.config;
      if (parsed.data.config) {
        const check = def.config.safeParse(parsed.data.config);
        if (!check.success) {
          const issue = check.error.issues[0];
          throw new HttpError(`${issue.path.join(".") || "config"}: ${issue.message}`, 422);
        }
        let previous: Record<string, unknown> = {};
        try {
          const p = JSON.parse(existing.config);
          if (p && typeof p === "object") previous = p as Record<string, unknown>;
        } catch {
          /* a corrupt column is replaced rather than merged */
        }
        const preserved = Object.fromEntries(
          PRESERVED_CONFIG_KEYS.filter((k) => previous[k] !== undefined).map((k) => [k, previous[k]]),
        );
        configJson = JSON.stringify({ ...preserved, ...check.data });
      }

      // --- secrets
      let secretsSealed = existing.secrets;
      const wipe = parsed.data.clearAllSecrets === true;
      if (incomingSecrets || wipe) {
        const vault = open<Record<string, string>>(existing.secrets, def.key);

        // A wipe needs no prior read, so it works even when the blob cannot be
        // decrypted - which is the one situation an admin must be able to
        // escape. It also permits clear-and-re-enter in a single save.
        if (vault.status === "unreadable" && !wipe) {
          // Refuse rather than overwrite: merging new values into an
          // assumed-empty object would destroy credentials we could not read.
          // Clearing everything is still allowed, so the console's own advice
          // ("clear and re-enter") is actually followable.
          throw new HttpError(
            `Stored credentials for ${def.name} cannot be decrypted (${vault.reason}). ` +
              "Use \"Clear stored credentials\" to discard them, or restore CONFIG_ENCRYPTION_KEY.",
            409,
          );
        }

        const current = !wipe && vault.status === "ok" ? { ...vault.value } : {};
        for (const [k, v] of Object.entries(incomingSecrets ?? {})) {
          if (v === "") delete current[k];
          else current[k] = v;
        }

        // The registry's own schema, finally enforced: rejects blank or
        // whitespace-only credentials that would otherwise be stored and only
        // fail later, at posting time.
        const shape = def.secrets.safeParse(current);
        if (!shape.success) {
          const issue = shape.error.issues[0];
          throw new HttpError(`${issue.path.join(".") || "secrets"}: ${issue.message}`, 422);
        }

        // Store the schema's OUTPUT, so what is sealed is the trimmed value the
        // validation actually approved rather than the raw input beside it.
        const approved = shape.data as Record<string, string>;
        secretsSealed = Object.keys(approved).length > 0 ? seal(approved, def.key) : null;
      }

      const enabled = parsed.data.enabled ?? existing.enabled;
      const siblings = def.exclusiveGroup
        ? INTEGRATIONS.filter((i) => i.key !== def.key && i.exclusiveGroup === def.exclusiveGroup).map((i) => i.key)
        : [];

      // Take the group lock FIRST. This is the only thing that actually makes
      // the invariant hold on Postgres: a count taken afterwards cannot see a
      // concurrent transaction's uncommitted write, so it would happily let two
      // integrations commit as active. Updating one shared row forces the
      // second transaction to wait and then act on committed state.
      if (def.exclusiveGroup) {
        await tx.integrationGroup.upsert({
          where: { group: def.exclusiveGroup },
          create: { group: def.exclusiveGroup, activeKey: enabled ? def.key : null },
          update: { activeKey: enabled ? def.key : null },
        });
      }

      if (enabled && siblings.length > 0) {
        await tx.integration.updateMany({
          where: { key: { in: siblings }, enabled: true },
          data: { enabled: false },
        });
      }

      // Guarded on the row version we read, so a concurrent writer that slipped
      // in between causes a conflict instead of a lost update.
      const written = await tx.integration.updateMany({
        where: { key: params.key, updatedAt: existing.updatedAt },
        data: { enabled, config: configJson, secrets: secretsSealed },
      });
      if (written.count === 0) {
        throw new HttpError("This integration was changed concurrently. Reload and try again.", 409);
      }

      // Belt and braces: assert the invariant actually holds before commit.
      if (def.exclusiveGroup) {
        const groupKeys = INTEGRATIONS.filter((i) => i.exclusiveGroup === def.exclusiveGroup).map((i) => i.key);
        const activeCount = await tx.integration.count({ where: { key: { in: groupKeys }, enabled: true } });
        if (activeCount > 1) {
          throw new HttpError("Refusing to leave two posting systems active. Try again.", 409);
        }
      }

      const updated = await tx.integration.findUniqueOrThrow({ where: { key: params.key } });
      return { updated, disabledKeys: enabled ? siblings : [] };
    });

    const reopened = open<Record<string, string>>(result.updated.secrets, def.key);
    const storedSecrets = reopened.status === "ok" ? reopened.value : {};

    return json({
      integration: {
        key: result.updated.key,
        name: result.updated.name,
        enabled: result.updated.enabled,
        config: publicConfig(def, safeJson(result.updated.config)),
        version: result.updated.updatedAt.toISOString(),
        secretsUnreadable: reopened.status === "unreadable",
        // Presence only, and a whitespace-only value is not presence.
        secretsSet: Object.fromEntries(
          secretFieldNames(def).map((n) => [n, typeof storedSecrets[n] === "string" && storedSecrets[n].trim() !== ""]),
        ),
      },
      disabled: result.disabledKeys,
    });
  } catch (e) {
    if (e instanceof HttpError) return error(e.message, e.status);
    throw e;
  }
});

/** Carries an HTTP status out of the transaction callback. */
class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
