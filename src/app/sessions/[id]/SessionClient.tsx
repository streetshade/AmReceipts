"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SessionDTO } from "@/lib/dto";
import { formatCents } from "@/lib/money";
import ReceiptPanel from "./ReceiptPanel";
import BarcodePanel from "./BarcodePanel";
import AssignmentPanel from "./AssignmentPanel";
import ApprovalBar from "./ApprovalBar";

type Tab = "receipts" | "items";

export default function SessionClient({ initial }: { initial: SessionDTO }) {
  const router = useRouter();
  const s = initial; // server component is the source of truth; refresh() re-fetches.
  const [tab, setTab] = useState<Tab>("receipts");

  const scannedTotal = s.scannedItems.reduce((acc, i) => acc + i.quantity, 0);
  const linkedCount = s.scannedItems.filter((i) => i.lineItemId).length;

  const refresh = () => router.refresh();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <a href="/dashboard" className="text-sm text-muted hover:text-content">
            ← All sessions
          </a>
          <h1 className="mt-1 text-2xl font-semibold">{s.name}</h1>
        </div>
        <div className="card border-l-2 border-l-gold px-5 py-3 text-right">
          <div className="text-xs uppercase tracking-wide text-muted">Session total</div>
          <div className="text-2xl font-bold text-gold">{formatCents(s.receiptTotal)}</div>
          <div className="mt-1 text-xs text-muted">
            {s.receipts.length} receipt{s.receipts.length === 1 ? "" : "s"} · {scannedTotal} item
            {scannedTotal === 1 ? "" : "s"} · {linkedCount} linked
          </div>
        </div>
      </div>

      {/* Assignment */}
      <AssignmentPanel session={s} onChange={refresh} />

      {/* Approval */}
      <ApprovalBar session={s} onChange={refresh} />

      {/* Tabs */}
      <div className="flex gap-2 border-b border-line">
        {(["receipts", "items"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
              tab === t ? "border-brand text-brand" : "border-transparent text-muted hover:text-content"
            }`}
          >
            {t === "receipts" ? `Receipts (${s.receipts.length})` : `Scanned items (${s.scannedItems.length})`}
          </button>
        ))}
      </div>

      {tab === "receipts" ? (
        <ReceiptPanel session={s} onChange={refresh} />
      ) : (
        <BarcodePanel session={s} onChange={refresh} />
      )}
    </div>
  );
}
