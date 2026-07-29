import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import AppHeader from "@/components/AppHeader";
import IntegrationsClient, { type IntegrationDTO } from "./IntegrationsClient";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/dashboard");

  const integrations = await prisma.integration.findMany({ orderBy: { name: "asc" } });
  const dtos: IntegrationDTO[] = integrations.map((i) => ({
    key: i.key,
    name: i.name,
    enabled: i.enabled,
    config: safeParse(i.config),
  }));

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
            Configure connections to external business systems. These are configuration placeholders — no data is synced
            yet.
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
