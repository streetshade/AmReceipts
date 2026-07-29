"use client";

import { useState } from "react";
import type { SessionDTO } from "@/lib/dto";
import type { ReasonOption } from "./SessionClient";

// Assign the session (and its costs) to a job number, or a travel/meeting reason,
// plus an optional managed reason from the group's catalog.
export default function AssignmentPanel({
  session,
  reasons,
  onChange,
}: {
  session: SessionDTO;
  reasons: ReasonOption[];
  onChange: () => void;
}) {
  const assigned = session.status === "assigned";
  const [open, setOpen] = useState(!assigned);
  const [mode, setMode] = useState<"job" | "travel" | "meeting">(
    session.reasonType === "travel" || session.reasonType === "meeting" ? session.reasonType : "job",
  );
  const [jobNumber, setJobNumber] = useState(session.jobNumber ?? "");
  const [jobName, setJobName] = useState(session.jobName ?? "");
  const [reasonNote, setReasonNote] = useState(session.reasonNote ?? "");
  const [reasonId, setReasonId] = useState(session.reasonId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> =
      mode === "job"
        ? { jobNumber: jobNumber.trim(), jobName: jobName.trim() || undefined }
        : { reasonType: mode, reasonNote: reasonNote.trim() || undefined };
    body.reasonId = reasonId || null;
    const res = await fetch(`/api/sessions/${session.id}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (res.ok) {
      setOpen(false);
      onChange();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Could not save assignment");
    }
  }

  const currentLabel = session.jobNumber
    ? `Job ${session.jobNumber}${session.jobName ? ` — ${session.jobName}` : ""}`
    : session.reasonType && session.reasonType !== "job"
      ? `${session.reasonType}${session.reasonNote ? `: ${session.reasonNote}` : ""}`
      : "Not assigned";

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted">Assigned to</div>
          <div className="font-medium capitalize">{currentLabel}</div>
          {session.reasonLabel && (
            <div className="mt-1">
              <span className="badge bg-brand/15 text-brand">{session.reasonLabel}</span>
            </div>
          )}
        </div>
        <button className="btn-secondary" onClick={() => setOpen((o) => !o)}>
          {open ? "Cancel" : assigned ? "Change" : "Assign"}
        </button>
      </div>

      {open && (
        <form onSubmit={save} className="mt-4 space-y-4 border-t border-line pt-4">
          <div className="flex gap-2">
            {(["job", "travel", "meeting"] as const).map((m) => (
              <button
                type="button"
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium capitalize ${
                  mode === m ? "border-brand bg-brand/10 text-brand" : "border-line text-muted"
                }`}
              >
                {m}
              </button>
            ))}
          </div>

          {mode === "job" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Job number</label>
                <input
                  className="input"
                  placeholder="JOB-1001"
                  value={jobNumber}
                  onChange={(e) => setJobNumber(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="label">Job name (optional)</label>
                <input className="input" value={jobName} onChange={(e) => setJobName(e.target.value)} />
              </div>
            </div>
          ) : (
            <div>
              <label className="label capitalize">{mode} reason</label>
              <input
                className="input"
                placeholder={mode === "travel" ? "e.g. Chicago site visit" : "e.g. Q3 planning with Acme"}
                value={reasonNote}
                onChange={(e) => setReasonNote(e.target.value)}
              />
            </div>
          )}

          {/* Optional managed reason from the group's catalog. */}
          <div>
            <label className="label">Reason (optional)</label>
            {reasons.length === 0 ? (
              <p className="text-sm text-muted">No reasons configured for your group yet.</p>
            ) : (
              <select className="input" value={reasonId} onChange={(e) => setReasonId(e.target.value)}>
                <option value="">— none —</option>
                {reasons.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            )}
          </div>

          {error && <p className="text-sm text-red-300">{error}</p>}
          <button className="btn-primary" disabled={busy}>
            {busy ? "Saving…" : "Save assignment"}
          </button>
        </form>
      )}
    </div>
  );
}
