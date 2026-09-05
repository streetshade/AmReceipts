import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import AppHeader from "@/components/AppHeader";
import { INTEGRATIONS, secretFieldNames } from "@/lib/integrations/registry";
import { open } from "@/lib/secretbox";
import IntegrationsClient, { type IntegrationDTO } from "./IntegrationsClient";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/dashboard");

  const rows = await prisma.integration.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));

  // Driven by the registry, not the table: an integration defined in code but
  // never seeded still appears (unconfigured) rather than silently missing.
  const dtos: IntegrationDTO[] = INTEGRATIONS.map((def) => {
    const row = byKey.get(def.key);
    const vault = open<Record<string, string>>(row?.secrets, def.key);
    const stored = vault.status === "ok" ? vault.value : {};
    // Parsed through the registry schema rather than passed through raw. This
    // is a Client Component prop, so it is serialised into the browser payload:
    // anything that reached the column by another route - a legacy shape, a
    // hand-edited row - must not ride along. Zod strips unknown keys, so
    // parsing is the redaction.
    const parsedConfig = def.config.safeParse(row ? safeParse(row.config) : {});
    return {
      key: def.key,
      name: def.name,
      description: def.description,
      exclusiveGroup: def.exclusiveGroup,
      fields: def.fields,
      enabled: row?.enabled ?? false,
      config: parsedConfig.success ? parsedConfig.data : {},
      version: row?.updatedAt.toISOString() ?? null,
      // Surfaced rather than swallowed: credentials that exist but cannot be
      // decrypted must not look identical to none being configured.
      secretsUnreadable: vault.status === "unreadable",
      // Presence only, and whitespace is not presence. Values are decrypted
      // here purely to answer "is it set?" and never leave the server.
      secretsSet: Object.fromEntries(
        secretFieldNames(def).map((n) => [n, typeof stored[n] === "string" && stored[n].trim() !== ""]),
      ),
    };
  });

  return (
    <>
      <AppHeader userName={me.name} role={me.role} />
      <main className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        <div>
          <Link href="/admin" className="text-sm text-muted hover:text-content">
            ← Administration
          </Link>
          <h1 className="mt-1 text-xl font-semibold">Business system integrations</h1>
          <p className="text-sm text-muted">
            Expenses post to one system of record. Enabling one switches the other off.
          </p>
        </div>
        <IntegrationsClient integrations={dtos} />
      </main>
    </>
  );
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
