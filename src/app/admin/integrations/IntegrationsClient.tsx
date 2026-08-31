"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { FieldDef } from "@/lib/integrations/registry";

export interface IntegrationDTO {
  key: string;
  name: string;
  description: string;
  exclusiveGroup: string | null;
  fields: FieldDef[];
  enabled: boolean;
  config: Record<string, unknown>;
  /** Whether each secret is stored. Never the value itself. */
  secretsSet: Record<string, boolean>;
}

export default function IntegrationsClient({ integrations }: { integrations: IntegrationDTO[] }) {
  // Held here rather than per-card so that enabling one can immediately show
  // the other as switched off, without waiting for a refresh.
  const [state, setState] = useState(integrations);

  function onEnabled(key: string, disabledKeys: string[]) {
    setState((prev) =>
      prev.map((i) =>
        i.key === key ? { ...i, enabled: true } : disabledKeys.includes(i.key) ? { ...i, enabled: false } : i,
      ),
    );
  }

  const active = state.find((i) => i.enabled && i.exclusiveGroup === "expense_posting");

  return (
    <div className="space-y-5">
      <div className="card p-4">
        <div className="text-xs uppercase tracking-wide text-muted">Active expense posting system</div>
        <div className="mt-1 font-semibold">
          {active ? active.name : <span className="text-muted">None — expenses are not posted anywhere</span>}
        </div>
      </div>

      {state.map((i) => (
        <IntegrationCard
          key={i.key}
          integration={i}
          onEnabled={onEnabled}
          onLocalChange={(next) => setState((prev) => prev.map((p) => (p.key === next.key ? next : p)))}
        />
      ))}
    </div>
  );
}

function IntegrationCard({
  integration,
  onEnabled,
  onLocalChange,
}: {
  integration: IntegrationDTO;
  onEnabled: (key: string, disabled: string[]) => void;
  onLocalChange: (next: IntegrationDTO) => void;
}) {
  const router = useRouter();
  const [config, setConfig] = useState<Record<string, unknown>>(integration.config);
  // Only what the admin has typed this session. An untouched secret is never
  // sent, so saving the form cannot blank a credential you did not re-enter.
  const [secretEdits, setSecretEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const groups = [...new Set(integration.fields.map((f) => f.group))];

  async function save(enabled: boolean) {
    setBusy(true);
    setSaved(false);
    setErr(null);
    const res = await fetch(`/api/admin/integrations/${integration.key}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled,
        config,
        ...(Object.keys(secretEdits).length > 0 ? { secrets: secretEdits } : {}),
      }),
    });
    setBusy(false);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setErr(body.error ?? "Could not save");
      return;
    }

    const data = await res.json();
    setSaved(true);
    setSecretEdits({});
    onLocalChange({
      ...integration,
      enabled: data.integration.enabled,
      config: data.integration.config,
      secretsSet: data.integration.secretsSet,
    });
    if (enabled) onEnabled(integration.key, data.disabled ?? []);
    router.refresh();
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save(integration.enabled);
      }}
      className="card overflow-hidden"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <span className="font-semibold">{integration.name}</span>
        <span className={`badge ${integration.enabled ? "bg-emerald-500/15 text-emerald-300" : "bg-panel2 text-muted"}`}>
          {integration.enabled ? "active" : "inactive"}
        </span>
        <button
          type="button"
          className="ml-auto btn-secondary"
          disabled={busy || integration.enabled}
          onClick={() => void save(true)}
          title={integration.enabled ? "Already the active system" : "Make this the active posting system"}
        >
          {integration.enabled ? "Active" : "Make active"}
        </button>
        {integration.enabled && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void save(false)}>
            Deactivate
          </button>
        )}
      </div>

      <p className="border-b border-line px-4 py-2 text-sm text-muted">{integration.description}</p>

      <div className="space-y-5 p-4">
        {groups.map((group) => (
          <fieldset key={group}>
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{group}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {integration.fields
                .filter((f) => f.group === group)
                .map((f) => (
                  <Field
                    key={f.name}
                    field={f}
                    value={config[f.name]}
                    secretStored={integration.secretsSet[f.name] ?? false}
                    secretEdit={secretEdits[f.name]}
                    onValue={(v) => setConfig({ ...config, [f.name]: v })}
                    onSecret={(v) => setSecretEdits({ ...secretEdits, [f.name]: v })}
                    onClearSecret={() => setSecretEdits({ ...secretEdits, [f.name]: "" })}
                  />
                ))}
            </div>
          </fieldset>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-line bg-panel2 px-4 py-2">
        <button className="btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save configuration"}
        </button>
        {saved && <span className="text-sm text-brand">Saved.</span>}
        {err && <span className="text-sm text-red-300">{err}</span>}
        <span className="ml-auto text-smallest text-muted">
          Secrets are encrypted and never displayed again.
        </span>
      </div>
    </form>
  );
}

function Field({
  field,
  value,
  secretStored,
  secretEdit,
  onValue,
  onSecret,
  onClearSecret,
}: {
  field: FieldDef;
  value: unknown;
  secretStored: boolean;
  secretEdit: string | undefined;
  onValue: (v: unknown) => void;
  onSecret: (v: string) => void;
  onClearSecret: () => void;
}) {
  const id = `f-${field.name}`;

  if (field.type === "boolean") {
    return (
      <label className="flex items-start gap-2 text-sm sm:col-span-2">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-brand"
          checked={Boolean(value)}
          onChange={(e) => onValue(e.target.checked)}
        />
        <span>
          {field.label}
          {field.help && <span className="block text-xs text-muted">{field.help}</span>}
        </span>
      </label>
    );
  }

  if (field.type === "select") {
    return (
      <div>
        <label className="label" htmlFor={id}>{field.label}</label>
        <select id={id} className="input" value={String(value ?? "")} onChange={(e) => onValue(e.target.value)}>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {field.help && <p className="mt-1 text-xs text-muted">{field.help}</p>}
      </div>
    );
  }

  if (field.secret) {
    const editing = secretEdit !== undefined;
    return (
      <div>
        <label className="label" htmlFor={id}>{field.label}</label>
        {/* A stored secret is never sent to the browser, so there is nothing to
            put in this box. It offers replacement, not display. */}
        {!editing && secretStored ? (
          <div className="flex items-center gap-2">
            <span className="badge bg-emerald-500/15 text-emerald-300">configured</span>
            <button type="button" className="text-sm text-muted underline hover:text-content" onClick={() => onSecret("")}>
              Replace
            </button>
            <button type="button" className="text-sm text-red-300 underline" onClick={onClearSecret}>
              Clear
            </button>
          </div>
        ) : (
          <input
            id={id}
            className="input"
            type="password"
            autoComplete="new-password"
            placeholder={secretStored ? "Enter a new value" : field.placeholder ?? "••••••••"}
            value={secretEdit ?? ""}
            onChange={(e) => onSecret(e.target.value)}
          />
        )}
        {field.help && <p className="mt-1 text-xs text-muted">{field.help}</p>}
      </div>
    );
  }

  return (
    <div>
      <label className="label" htmlFor={id}>{field.label}</label>
      <input
        id={id}
        className="input"
        type={field.type === "number" ? "number" : "text"}
        placeholder={field.placeholder}
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(e) => onValue(field.type === "number" ? Number(e.target.value) : e.target.value)}
      />
      {field.help && <p className="mt-1 text-xs text-muted">{field.help}</p>}
    </div>
  );
}
