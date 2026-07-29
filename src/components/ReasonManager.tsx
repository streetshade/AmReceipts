"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface ManagedReason {
  id: string;
  label: string;
  active: boolean;
  groupId: string | null;
  groupName: string | null;
}

export interface ManageGroup {
  id: string;
  name: string;
}

// Reason catalog manager, shared by admins (all groups + global) and approvers
// (their overseen groups only). `allowGlobal` enables the "All groups" scope.
export default function ReasonManager({
  reasons,
  groups,
  allowGlobal,
}: {
  reasons: ManagedReason[];
  groups: ManageGroup[];
  allowGlobal: boolean;
}) {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<string>(allowGlobal ? "" : (groups[0]?.id ?? ""));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim()) return;
    setBusy("new");
    setError(null);
    const res = await fetch("/api/reasons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: label.trim(), groupId: scope || null }),
    });
    setBusy(null);
    if (res.ok) {
      setLabel("");
      router.refresh();
    } else {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "Could not add reason");
    }
  }

  async function toggle(r: ManagedReason) {
    setBusy(r.id);
    await fetch(`/api/reasons/${r.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !r.active }),
    });
    setBusy(null);
    router.refresh();
  }

  async function remove(r: ManagedReason) {
    if (!confirm(`Delete reason "${r.label}"?`)) return;
    setBusy(r.id);
    await fetch(`/api/reasons/${r.id}`, { method: "DELETE" });
    setBusy(null);
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="card divide-y divide-line">
        {reasons.length === 0 && <p className="p-4 text-sm text-muted">No reasons yet.</p>}
        {reasons.map((r) => (
          <div key={r.id} className={`flex items-center justify-between gap-3 p-3 ${busy === r.id ? "opacity-50" : ""}`}>
            <div className="min-w-0">
              <div className="font-medium">{r.label}</div>
              <div className="text-xs text-muted">{r.groupName ?? "All groups (global)"}</div>
            </div>
            <div className="flex items-center gap-3">
              <span className={`badge ${r.active ? "bg-emerald-500/15 text-emerald-300" : "bg-panel2 text-muted"}`}>
                {r.active ? "active" : "inactive"}
              </span>
              <button className="text-xs text-muted hover:text-content" onClick={() => toggle(r)}>
                {r.active ? "Disable" : "Enable"}
              </button>
              <button className="text-xs text-muted hover:text-red-300" onClick={() => remove(r)}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={create} className="flex flex-wrap gap-2">
        <input
          className="input flex-1"
          placeholder="New reason (e.g. Emergency callout)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <select
          className="rounded-lg border border-line bg-panel2 px-3 py-2 text-sm text-content"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        >
          {allowGlobal && <option value="">All groups (global)</option>}
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <button className="btn-secondary shrink-0" disabled={busy === "new" || !label.trim()}>
          Add reason
        </button>
      </form>
      {error && <p className="text-sm text-red-300">{error}</p>}
    </div>
  );
}
