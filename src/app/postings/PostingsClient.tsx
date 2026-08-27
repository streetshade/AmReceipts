"use client";

import { useCallback, useEffect, useState } from "react";
import { formatCents } from "@/lib/money";
import type { AuditRow } from "@/lib/m3/audit";

// Status presentation. `unknown` is styled as the loudest thing on the page on
// purpose: it is the only status that means a voucher may exist in M3 that this
// app does not know about, and it is the reason this screen exists.
const STATUS_META: Record<string, { label: string; className: string; hint?: string }> = {
  posted: { label: "Posted", className: "bg-emerald-500/15 text-emerald-300" },
  pending: { label: "Pending", className: "bg-panel2 text-muted" },
  posting: { label: "Sending", className: "bg-sky-500/15 text-sky-300", hint: "A send is in flight. If it stays here, the worker died and it will be moved to Unknown." },
  rejected: { label: "Rejected", className: "bg-amber-500/15 text-amber-300", hint: "M3 refused it. Safe to correct and retry." },
  unknown: {
    label: "Unknown",
    className: "bg-red-500/20 text-red-300 ring-1 ring-red-500/40",
    hint: "Sent, but the outcome was never confirmed. Check M3 for the reference before re-posting.",
  },
  blocked: { label: "Blocked", className: "bg-amber-500/15 text-amber-300", hint: "Could not be built or sent." },
  reversed: { label: "Reversed", className: "bg-panel2 text-muted" },
};

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, className: "bg-panel2 text-muted" };
  return <span className={`badge ${meta.className}`}>{meta.label}</span>;
}

const STATUSES = ["", "pending", "posting", "posted", "rejected", "unknown", "blocked", "reversed"];

interface Filters {
  userId: string;
  jobNumber: string;
  status: string;
  from: string;
  to: string;
  search: string;
}

const EMPTY: Filters = { userId: "", jobNumber: "", status: "", from: "", to: "", search: "" };

function toQuery(f: Filters): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  return p.toString();
}

export default function PostingsClient({
  initialRows,
  initialCursor,
  initialSummary,
  jobNumbers,
  users,
  canFilterUsers,
}: {
  initialRows: AuditRow[];
  initialCursor: string | null;
  initialSummary: Record<string, number>;
  jobNumbers: string[];
  users: { id: string; name: string }[];
  canFilterUsers: boolean;
}) {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [rows, setRows] = useState(initialRows);
  const [cursor, setCursor] = useState(initialCursor);
  const [summary, setSummary] = useState(initialSummary);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const load = useCallback(async (f: Filters) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/m3/postings?${toQuery(f)}`);
      if (!res.ok) return;
      const data = await res.json();
      setRows(data.rows);
      setCursor(data.nextCursor);
      setSummary(data.summary);
    } finally {
      setBusy(false);
    }
  }, []);

  // Debounced so typing in the search box does not fire a request per keystroke.
  // Skipped on first render: the server already sent an unfiltered first page.
  useEffect(() => {
    if (!touched) return;
    const t = setTimeout(() => void load(filters), 300);
    return () => clearTimeout(t);
  }, [filters, touched, load]);

  function set<K extends keyof Filters>(key: K, value: Filters[K]) {
    setTouched(true);
    setFilters((f) => ({ ...f, [key]: value }));
  }

  async function loadMore() {
    if (!cursor) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/m3/postings?${toQuery(filters)}&cursor=${cursor}`);
      if (!res.ok) return;
      const data = await res.json();
      setRows((prev) => [...prev, ...data.rows]);
      setCursor(data.nextCursor);
    } finally {
      setBusy(false);
    }
  }

  const unknownCount = summary.unknown ?? 0;

  return (
    <div className="space-y-4">
      {unknownCount > 0 && (
        <div className="card border-l-2 border-l-red-500 p-4">
          <div className="font-semibold text-red-300">
            {unknownCount} posting{unknownCount === 1 ? "" : "s"} with an unconfirmed outcome
          </div>
          <p className="mt-1 text-sm text-muted">
            These were sent to M3 but never confirmed. Search M3 for each reference before re-posting — the voucher
            may already exist.
          </p>
        </div>
      )}

      <div className="card p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {canFilterUsers && (
            <div>
              <label className="label" htmlFor="f-user">Person</label>
              <select id="f-user" className="input" value={filters.userId} onChange={(e) => set("userId", e.target.value)}>
                <option value="">Everyone</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="label" htmlFor="f-job">Job</label>
            <select id="f-job" className="input" value={filters.jobNumber} onChange={(e) => set("jobNumber", e.target.value)}>
              <option value="">All jobs</option>
              {jobNumbers.map((j) => (
                <option key={j} value={j}>{j}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="f-status">Status</label>
            <select id="f-status" className="input" value={filters.status} onChange={(e) => set("status", e.target.value)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{s === "" ? "Any status" : (STATUS_META[s]?.label ?? s)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="f-from">Accounting date from</label>
            <input id="f-from" type="date" className="input" value={filters.from} onChange={(e) => set("from", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="f-to">Accounting date to</label>
            <input id="f-to" type="date" className="input" value={filters.to} onChange={(e) => set("to", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="f-search">Reference or voucher</label>
            <input
              id="f-search"
              className="input"
              placeholder="AMR… or voucher no"
              value={filters.search}
              onChange={(e) => set("search", e.target.value)}
            />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <a className="btn-secondary" href={`/api/m3/postings/export?view=lines&${toQuery(filters)}`}>
            Export lines
          </a>
          <a className="btn-secondary" href={`/api/m3/postings/export?view=attempts&${toQuery(filters)}`}>
            Export attempts
          </a>
          <button
            className="btn-secondary"
            onClick={() => { setTouched(true); setFilters(EMPTY); }}
            disabled={busy}
          >
            Clear filters
          </button>
          <span className="ml-auto text-smallest text-muted">
            {busy ? "Loading…" : `${rows.length} posting${rows.length === 1 ? "" : "s"}${cursor ? "+" : ""}`}
          </span>
        </div>
      </div>

      <div className="card overflow-hidden">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">No postings match these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2.5">Reference</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Person</th>
                  <th className="px-4 py-2.5">Job</th>
                  <th className="px-4 py-2.5">Voucher</th>
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5 text-right">Amount</th>
                  <th className="px-4 py-2.5 text-right">Tries</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <PostingRow
                    key={r.id}
                    row={r}
                    open={expanded === r.id}
                    onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cursor && (
          <div className="border-t border-line bg-panel2 px-4 py-2">
            <button className="btn-secondary" onClick={loadMore} disabled={busy}>
              {busy ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function PostingRow({ row, open, onToggle }: { row: AuditRow; open: boolean; onToggle: () => void }) {
  const meta = STATUS_META[row.status];
  return (
    <>
      <tr className="cursor-pointer hover:bg-panel2/50" onClick={onToggle}>
        <td className="px-4 py-2.5 font-mono text-xs">{row.reference}</td>
        <td className="px-4 py-2.5"><StatusBadge status={row.status} /></td>
        <td className="px-4 py-2.5">{row.user.name}</td>
        <td className="px-4 py-2.5">{row.job.number ?? <span className="text-muted">—</span>}</td>
        <td className="px-4 py-2.5 font-mono text-xs">{row.voucherNo ?? <span className="text-muted">—</span>}</td>
        <td className="px-4 py-2.5">{row.accountingDate}</td>
        <td className="px-4 py-2.5 text-right font-medium">{formatCents(row.amountCents, row.currency)}</td>
        <td className="px-4 py-2.5 text-right">{row.attempts}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} className="bg-panel2/40 px-4 py-4">
            <div className="space-y-4">
              {meta?.hint && <p className="text-sm text-muted">{meta.hint}</p>}

              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
                <Detail label="Company / division" value={`${row.cono} / ${row.divi}`} />
                <Detail label="Document" value={row.documentType} />
                <Detail label="Profile" value={row.postingProfileKey} />
                <Detail label="Supplier" value={row.supplierNo ?? "—"} />
                <Detail label="Voucher series" value={row.voucherSeries ?? "—"} />
                <Detail label="Fiscal year" value={row.fiscalYear ?? "—"} />
                <Detail label="Group" value={row.groupName ?? "—"} />
                <Detail label="Posted at" value={row.postedAt ? new Date(row.postedAt).toLocaleString() : "—"} />
              </dl>

              <Section title="Voucher lines as sent">
                {row.lines.length === 0 ? (
                  <p className="text-sm text-muted">No lines were built for this posting.</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="text-left text-muted">
                      <tr>
                        <th className="py-1 pr-3">#</th>
                        <th className="py-1 pr-3">Account</th>
                        <th className="py-1 pr-3">Dimensions</th>
                        <th className="py-1 pr-3">Description</th>
                        <th className="py-1 pr-3">VAT</th>
                        <th className="py-1 text-right">Tax</th>
                        <th className="py-1 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line/50">
                      {row.lines.map((l) => (
                        <tr key={l.lineNo}>
                          <td className="py-1 pr-3">{l.lineNo}</td>
                          <td className="py-1 pr-3 font-mono">{l.account}</td>
                          <td className="py-1 pr-3 font-mono text-muted">
                            {l.dimensions.filter(Boolean).join(" · ") || "—"}
                          </td>
                          <td className="py-1 pr-3">
                            {l.description}
                            {l.viaSuspense && <span className="badge ml-2 bg-amber-500/15 text-amber-300">suspense</span>}
                            {l.routedBy.length > 0 && (
                              <span className="ml-2 text-muted" title={`Routing rules: ${l.routedBy.join(", ")}`}>
                                ({l.routedBy.length} rule{l.routedBy.length === 1 ? "" : "s"})
                              </span>
                            )}
                          </td>
                          <td className="py-1 pr-3">{l.vatCode ?? "—"}</td>
                          <td className="py-1 text-right text-muted">{formatCents(l.taxCents, row.currency)}</td>
                          <td className="py-1 text-right">{formatCents(l.amountCents, row.currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Section>

              <Section title="Attempt history">
                {row.attemptLog.length === 0 ? (
                  <p className="text-sm text-muted">Not yet attempted.</p>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {row.attemptLog.map((a) => (
                      <li key={a.attemptNo} className="flex flex-wrap items-baseline gap-x-3">
                        <span className="text-muted">#{a.attemptNo}</span>
                        <span className={a.ambiguous ? "font-semibold text-red-300" : ""}>{a.outcome}</span>
                        <span className="text-muted">{new Date(a.startedAt).toLocaleString()}</span>
                        {a.finishedAt === null && a.outcome === "in_flight" && (
                          <span className="font-semibold text-red-300">still open</span>
                        )}
                        {a.program && <span className="font-mono text-muted">{a.program}/{a.transaction}</span>}
                        {a.httpStatus !== null && <span className="text-muted">HTTP {a.httpStatus}</span>}
                        {a.durationMs !== null && <span className="text-muted">{a.durationMs}ms</span>}
                        {/* The per-attempt voucher matters: a posting's final
                            voucher number would otherwise hide an earlier
                            attempt that returned a different one. */}
                        {a.voucherNo && <span className="font-mono">voucher {a.voucherNo}</span>}
                        <span className="text-muted">by {a.actor}</span>
                        {a.m3Message && <span className="w-full text-muted">{a.m3Message}</span>}
                        {a.requestParams && (
                          <details className="w-full">
                            <summary className="cursor-pointer text-muted">Parameters sent</summary>
                            <pre className="mt-1 overflow-x-auto rounded bg-ink/60 p-2 font-mono text-[11px]">
                              {JSON.stringify(a.requestParams, null, 2)}
                            </pre>
                          </details>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{title}</div>
      {children}
    </div>
  );
}
