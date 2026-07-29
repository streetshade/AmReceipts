"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface IntegrationDTO {
  key: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

// Human labels + input hints for known config fields.
const FIELD_META: Record<string, { label: string; type: "text" | "password" | "bool"; placeholder?: string }> = {
  baseUrl: { label: "Base URL", type: "text", placeholder: "https://psaweb.example.com/api" },
  apiKey: { label: "API key", type: "password", placeholder: "••••••••" },
  companyId: { label: "Company ID", type: "text", placeholder: "e.g. 10432" },
  syncExpenses: { label: "Sync approved expenses", type: "bool" },
};

function metaFor(key: string) {
  return FIELD_META[key] ?? { label: key, type: "text" as const };
}

export default function IntegrationsClient({ integrations }: { integrations: IntegrationDTO[] }) {
  return (
    <div className="space-y-5">
      {integrations.map((i) => (
        <IntegrationCard key={i.key} integration={i} />
      ))}
    </div>
  );
}

function IntegrationCard({ integration }: { integration: IntegrationDTO }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(integration.enabled);
  const [config, setConfig] = useState<Record<string, unknown>>(integration.config);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSaved(false);
    const res = await fetch(`/api/admin/integrations/${integration.key}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, config }),
    });
    setBusy(false);
    if (res.ok) {
      setSaved(true);
      router.refresh();
    }
  }

  const fields = Object.keys(integration.config);

  return (
    <form onSubmit={save} className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{integration.name}</span>
          <span className={`badge ${enabled ? "bg-emerald-500/15 text-emerald-300" : "bg-panel2 text-muted"}`}>
            {enabled ? "enabled" : "disabled"}
          </span>
          <span className="badge bg-gold/15 text-gold">placeholder</span>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" className="h-4 w-4 accent-brand" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
      </div>

      <div className="grid gap-3 p-4 sm:grid-cols-2">
        {fields.length === 0 && <p className="text-sm text-muted">No configurable fields.</p>}
        {fields.map((k) => {
          const meta = metaFor(k);
          if (meta.type === "bool") {
            return (
              <label key={k} className="flex items-center gap-2 text-sm sm:col-span-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-brand"
                  checked={Boolean(config[k])}
                  onChange={(e) => setConfig({ ...config, [k]: e.target.checked })}
                />
                {meta.label}
              </label>
            );
          }
          return (
            <div key={k}>
              <label className="label">{meta.label}</label>
              <input
                className="input"
                type={meta.type}
                placeholder={meta.placeholder}
                value={String(config[k] ?? "")}
                onChange={(e) => setConfig({ ...config, [k]: e.target.value })}
              />
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3 border-t border-line bg-panel2 px-4 py-2">
        <button className="btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save configuration"}
        </button>
        {saved && <span className="text-sm text-brand">Saved.</span>}
        <span className="ml-auto text-smallest text-muted">Stub — stored only; no sync performed.</span>
      </div>
    </form>
  );
}
