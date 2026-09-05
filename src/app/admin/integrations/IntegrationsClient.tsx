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
  /** Credentials are stored but could not be decrypted. */
  secretsUnreadable: boolean;
  /** Row version, echoed back on save to detect a concurrent edit. */
  version: string | null;
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
  // What the admin actually typed this session. An untouched secret is never
  // sent, so saving cannot blank a credential nobody re-entered.
  const [secretEdits, setSecretEdits] = useState<Record<string, string>>({});
  // Secrets whose input has been opened for replacement. Deliberately separate
  // from `secretEdits`: staging an empty string on "Replace" meant that
  // clicking it and saving without typing anything DELETED the credential.
  const [replacing, setReplacing] = useState<Set<string>>(new Set());
  // Secrets explicitly marked for deletion. Only these send "".
  const [clearing, setClearing] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const groups = [...new Set(integration.fields.map((f) => f.group))];

  /** Recovery from an undecryptable blob: discard it and start again. */
  async function clearAllSecrets() {
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/admin/integrations/${integration.key}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      // Any values typed alongside are applied on top of the wipe, so
      // "clear and re-enter" really is one action.
      body: JSON.stringify({ clearAllSecrets: true, secrets: secretEdits }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setErr(body.error ?? "Could not clear credentials");
      return;
    }
    const data = await res.json();
    setSecretEdits({});
    setReplacing(new Set());
    setClearing(new Set());
    onLocalChange({
      ...integration,
      secretsSet: data.integration.secretsSet,
      secretsUnreadable: data.integration.secretsUnreadable ?? false,
      version: data.integration.version ?? integration.version,
    });
    router.refresh();
  }

  async function save(enabled: boolean) {
    setBusy(true);
    setSaved(false);
    setErr(null);
    // Typed values, plus explicit clears as "". A field merely opened for
    // replacement and left blank sends nothing at all.
    const secrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(secretEdits)) if (v !== "") secrets[k] = v;
    for (const k of clearing) secrets[k] = "";

    const res = await fetch(`/api/admin/integrations/${integration.key}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled,
        config,
        ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
        ...(integration.version ? { expectedVersion: integration.version } : {}),
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
    setReplacing(new Set());
    setClearing(new Set());
    onLocalChange({
      ...integration,
      enabled: data.integration.enabled,
      config: data.integration.config,
      secretsSet: data.integration.secretsSet,
      secretsUnreadable: data.integration.secretsUnreadable ?? false,
      version: data.integration.version ?? integration.version,
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

      {integration.secretsUnreadable && (
        <div className="space-y-2 border-b border-line bg-red-500/10 px-4 py-3 text-sm text-red-300">
          <p>
            Stored credentials cannot be decrypted — usually because CONFIG_ENCRYPTION_KEY changed. Saving
            new credentials is refused while this is true, so that whatever is stored is not overwritten by
            accident.
          </p>
          <p className="text-muted">
            Restore the previous key to recover them, or discard them and enter new ones. You can type
            replacements into the fields below first and they will be applied in the same step.
          </p>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void clearAllSecrets()}>
            Clear stored credentials
          </button>
        </div>
      )}

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
                    replacing={replacing.has(f.name)}
                    clearing={clearing.has(f.name)}
                    onValue={(v) => setConfig({ ...config, [f.name]: v })}
                    onSecret={(v) => setSecretEdits({ ...secretEdits, [f.name]: v })}
                    onStartReplace={() => setReplacing(new Set(replacing).add(f.name))}
                    onToggleClear={() => {
                      const next = new Set(clearing);
                      next.has(f.name) ? next.delete(f.name) : next.add(f.name);
                      setClearing(next);
                    }}
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
  replacing,
  clearing,
  onValue,
  onSecret,
  onStartReplace,
  onToggleClear,
}: {
  field: FieldDef;
  value: unknown;
  secretStored: boolean;
  secretEdit: string | undefined;
  replacing: boolean;
  clearing: boolean;
  onValue: (v: unknown) => void;
  onSecret: (v: string) => void;
  onStartReplace: () => void;
  onToggleClear: () => void;
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
    // A stored secret is never sent to the browser, so there is nothing to put
    // in this box. It offers replacement, not display.
    const showInput = !secretStored || replacing;
    return (
      <div>
        <label className="label" htmlFor={id}>{field.label}</label>
        {secretStored && !replacing ? (
          <div className="flex flex-wrap items-center gap-2">
            {clearing ? (
              <>
                <span className="badge bg-red-500/15 text-red-300">will be cleared on save</span>
                <button type="button" className="text-sm text-muted underline hover:text-content" onClick={onToggleClear}>
                  Keep
                </button>
              </>
            ) : (
              <>
                <span className="badge bg-emerald-500/15 text-emerald-300">configured</span>
                <button type="button" className="text-sm text-muted underline hover:text-content" onClick={onStartReplace}>
                  Replace
                </button>
                <button type="button" className="text-sm text-red-300 underline" onClick={onToggleClear}>
                  Clear
                </button>
              </>
            )}
          </div>
        ) : null}
        {showInput && (
          <input
            id={id}
            className="input"
            type="password"
            autoComplete="new-password"
            placeholder={secretStored ? "Enter a new value (leave blank to keep the current one)" : field.placeholder ?? "••••••••"}
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
