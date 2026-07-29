"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";

export interface ApprovalRow {
  id: string;
  name: string;
  ownerName: string;
  ownerTitle: string | null;
  approvalStatus: string;
  approvalNote: string | null;
  submittedAt: string | null;
  project: string | null;
  reason: string | null;
  total: number;
}

const STATUS_STYLE: Record<string, string> = {
  submitted: "bg-amber-500/15 text-amber-300",
  approved: "bg-emerald-500/15 text-emerald-300",
  rejected: "bg-red-500/15 text-red-300",
};

export default function ApprovalsClient({ rows }: { rows: ApprovalRow[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  const pending = rows.filter((r) => r.approvalStatus === "submitted");
  const decided = rows.filter((r) => r.approvalStatus !== "submitted");

  async function decide(id: string, decision: "approve" | "reject") {
    let note: string | undefined;
    if (decision === "reject") {
      note = window.prompt("Reason for rejection (optional):") ?? undefined;
    }
    setBusyId(id);
    const res = await fetch(`/api/approvals/${id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, note }),
    });
    setBusyId(null);
    if (res.ok) router.refresh();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Approvals</h1>
        <p className="text-sm text-muted">Review expense sessions submitted by the people you oversee.</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Awaiting approval ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <div className="card p-8 text-center text-muted">Nothing awaiting approval.</div>
        ) : (
          pending.map((r) => (
            <div key={r.id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/sessions/${r.id}`} className="font-semibold hover:text-brand">
                    {r.name}
                  </Link>
                  <p className="text-sm text-muted">
                    {r.ownerName}
                    {r.ownerTitle && ` · ${r.ownerTitle}`}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {r.project ?? r.reason ?? "Unassigned"}
                    {r.submittedAt && ` · submitted ${new Date(r.submittedAt).toLocaleDateString()}`}
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-lg font-semibold text-gold">{formatCents(r.total)}</div>
                </div>
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  className="btn-danger"
                  disabled={busyId === r.id}
                  onClick={() => decide(r.id, "reject")}
                >
                  Reject
                </button>
                <button
                  className="btn-primary"
                  disabled={busyId === r.id}
                  onClick={() => decide(r.id, "approve")}
                >
                  {busyId === r.id ? "…" : "Approve"}
                </button>
              </div>
            </div>
          ))
        )}
      </section>

      {decided.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Recent decisions</h2>
          <div className="card divide-y divide-line">
            {decided.slice(0, 20).map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <Link href={`/sessions/${r.id}`} className="font-medium hover:text-brand">
                    {r.name}
                  </Link>
                  <p className="text-xs text-muted">{r.ownerName}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium">{formatCents(r.total)}</span>
                  <span className={`badge ${STATUS_STYLE[r.approvalStatus] ?? ""}`}>{r.approvalStatus}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
