"use client";

import { useState } from "react";
import type { SessionDTO } from "@/lib/dto";

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-panel2 text-muted",
  submitted: "bg-amber-500/15 text-amber-300",
  approved: "bg-emerald-500/15 text-emerald-300",
  rejected: "bg-red-500/15 text-red-300",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  submitted: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
};

// Owner-facing approval control: submit a draft/rejected session for approval,
// and show the current approval state.
export default function ApprovalBar({ session, onChange }: { session: SessionDTO; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const status = session.approvalStatus;
  const canSubmit = status === "draft" || status === "rejected";

  async function submit() {
    setBusy(true);
    const res = await fetch(`/api/sessions/${session.id}/submit`, { method: "POST" });
    setBusy(false);
    if (res.ok) onChange();
  }

  return (
    <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
      <div>
        <div className="text-xs uppercase tracking-wide text-muted">Approval</div>
        <div className="mt-1 flex items-center gap-2">
          <span className={`badge ${STATUS_STYLE[status] ?? STATUS_STYLE.draft}`}>
            {STATUS_LABEL[status] ?? status}
          </span>
          {status === "approved" && session.approvedByName && (
            <span className="text-sm text-muted">by {session.approvedByName}</span>
          )}
        </div>
        {status === "rejected" && session.approvalNote && (
          <p className="mt-2 text-sm text-red-300">Reason: {session.approvalNote}</p>
        )}
        {status === "submitted" && (
          <p className="mt-1 text-smallest text-muted">Submitted — your approver will review it.</p>
        )}
      </div>
      {canSubmit && (
        <button className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? "Submitting…" : status === "rejected" ? "Resubmit" : "Submit for approval"}
        </button>
      )}
    </div>
  );
}
