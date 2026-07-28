"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";

interface SessionRow {
  id: string;
  name: string;
  status: string;
  reasonType: string | null;
  reasonNote: string | null;
  job: { number: string; name: string | null } | null;
  receiptCount: number;
  itemCount: number;
  total: number;
  createdAt: string;
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    open: "bg-amber-500/15 text-amber-300",
    assigned: "bg-emerald-500/15 text-emerald-300",
    closed: "bg-panel2 text-muted",
  };
  return <span className={`badge ${styles[status] ?? styles.open}`}>{status}</span>;
}

function assignmentLabel(s: SessionRow): string {
  if (s.job) return s.job.name ? `${s.job.number} — ${s.job.name}` : s.job.number;
  if (s.reasonType && s.reasonType !== "job") {
    return s.reasonNote ? `${s.reasonType}: ${s.reasonNote}` : s.reasonType;
  }
  return "Unassigned";
}

export default function DashboardClient({ initialSessions }: { initialSessions: SessionRow[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function createSession(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    setBusy(false);
    if (res.ok) {
      const { id } = await res.json();
      router.push(`/sessions/${id}`);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Expense sessions</h1>
      </div>

      <form onSubmit={createSession} className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label className="label">Start a new session</label>
          <input
            className="input"
            placeholder="e.g. Client visit — Tuesday"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <button className="btn-primary sm:w-40" disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "New session"}
        </button>
      </form>

      {initialSessions.length === 0 ? (
        <div className="card p-8 text-center text-muted">
          No sessions yet. Start one above, then scan receipts and product barcodes.
        </div>
      ) : (
        <ul className="space-y-3">
          {initialSessions.map((s) => (
            <li key={s.id}>
              <Link href={`/sessions/${s.id}`} className="card block p-4 transition hover:border-brand/40 hover:shadow">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="font-semibold">{s.name}</h2>
                      <StatusBadge status={s.status} />
                    </div>
                    <p className="mt-1 text-sm text-muted">{assignmentLabel(s)}</p>
                    <p className="mt-2 text-xs text-muted">
                      {s.receiptCount} receipt{s.receiptCount === 1 ? "" : "s"} · {s.itemCount} scanned item
                      {s.itemCount === 1 ? "" : "s"} · {new Date(s.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-semibold">{formatCents(s.total)}</div>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
