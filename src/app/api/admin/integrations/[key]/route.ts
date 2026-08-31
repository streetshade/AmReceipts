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
});

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

  const existing = await prisma.integration.findUnique({ where: { key: params.key } });
  if (!existing) return error("Integration not found", 404);

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return error("Invalid input", 422);

  // --- config ---------------------------------------------------------
  let configJson = existing.config;
  if (parsed.data.config) {
    const result = def.config.safeParse(parsed.data.config);
    if (!result.success) {
      const issue = (result as z.SafeParseError<unknown>).error.issues[0];
      return error(`${issue.path.join(".") || "config"}: ${issue.message}`, 422);
    }
    configJson = JSON.stringify(result.data);
  }

  // --- secrets --------------------------------------------------------
  let secretsSealed = existing.secrets;
  if (parsed.data.secrets) {
    const allowed = new Set(secretFieldNames(def));
    const incoming = Object.entries(parsed.data.secrets).filter(([k]) => allowed.has(k));

    const current = (open<Record<string, string>>(existing.secrets) ?? {});
    for (const [k, v] of incoming) {
      // Empty means "clear this credential", which has to be expressible -
      // otherwise a secret can be replaced but never removed.
      if (v === "") delete current[k];
      else current[k] = v;
    }
    secretsSealed = Object.keys(current).length > 0 ? seal(current) : null;
  }

  // --- enabled, with mutual exclusion ---------------------------------
  const enabled = parsed.data.enabled ?? existing.enabled;

  const updated = await prisma.$transaction(async (tx) => {
    // Turning one on turns its siblings off, in the same transaction. Expenses
    // have one system of record; two enabled at once would post the same spend
    // into two ledgers, and reconciling that afterwards is far worse than the
    // inconvenience of an explicit switch.
    if (enabled && def.exclusiveGroup) {
      const siblings = INTEGRATIONS
        .filter((i) => i.key !== def.key && i.exclusiveGroup === def.exclusiveGroup)
        .map((i) => i.key);
      if (siblings.length > 0) {
        await tx.integration.updateMany({
          where: { key: { in: siblings }, enabled: true },
          data: { enabled: false },
        });
      }
    }

    return tx.integration.update({
      where: { key: params.key },
      data: { enabled, config: configJson, secrets: secretsSealed },
    });
  });

  const storedSecrets = open<Record<string, string>>(updated.secrets) ?? {};
  return json({
    integration: {
      key: updated.key,
      name: updated.name,
      enabled: updated.enabled,
      config: JSON.parse(updated.config),
      // Presence only. The values never leave the server.
      secretsSet: Object.fromEntries(secretFieldNames(def).map((n) => [n, Boolean(storedSecrets[n])])),
    },
    // So the console can reflect a sibling being switched off without a reload.
    disabled: enabled && def.exclusiveGroup
      ? INTEGRATIONS.filter((i) => i.key !== def.key && i.exclusiveGroup === def.exclusiveGroup).map((i) => i.key)
      : [],
  });
});
