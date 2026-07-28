"use client";

import { useState } from "react";
import type { SessionDTO } from "@/lib/dto";

// Assign the session (and its costs) to a job number, or to a travel/meeting reason.
export default function AssignmentPanel({ session, onChange }: { session: SessionDTO; onChange: () => void }) {
  const assigned = session.status === "assigned";
  const [open, setOpen] = useState(!assigned);
  const [mode, setMode] = useState<"job" | "travel" | "meeting">(
    session.reasonType === "travel" || session.reasonType === "meeting" ? session.reasonType : "job",
  );
  const [jobNumber, setJobNumber] = useState(session.jobNumber ?? "");
  const [jobName, setJobName] = useState(session.jobName ?? "");
  const [reasonNote, setReasonNote] = useState(session.reasonNote ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body =
      mode === "job"
        ? { jobNumber: jobNumber.trim(), jobName: jobName.trim() || undefined }
        : { reasonType: mode, reasonNote: reasonNote.trim() || undefined };
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

          {error && <p className="text-sm text-red-300">{error}</p>}
          <button className="btn-primary" disabled={busy}>
            {busy ? "Saving…" : "Save assignment"}
          </button>
        </form>
      )}
    </div>
  );
}
