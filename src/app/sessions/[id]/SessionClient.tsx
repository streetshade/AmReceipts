"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SessionDTO } from "@/lib/dto";
import { formatCents } from "@/lib/money";
import ReceiptPanel from "./ReceiptPanel";
import BarcodePanel from "./BarcodePanel";
import AssignmentPanel from "./AssignmentPanel";
import ApprovalBar from "./ApprovalBar";
import CapturePanel from "./field/CapturePanel";
import type { UiVersion } from "@/lib/settings";

type Tab = "receipts" | "items";

export default function SessionClient({
  initial,
  uiVersion = "field",
}: {
  initial: SessionDTO;
  uiVersion?: UiVersion;
}) {
  const router = useRouter();
  const s = initial; // server component is the source of truth; refresh() re-fetches.
  const [tab, setTab] = useState<Tab>("receipts");
  // Capture is a full-screen pushed surface in the field design, not a panel:
  // the camera needs the whole viewport, and everything else on the page is a
  // distraction while a technician is trying to photograph a receipt.
  const [capturing, setCapturing] = useState(false);

  const scannedTotal = s.scannedItems.reduce((acc, i) => acc + i.quantity, 0);
  const linkedCount = s.scannedItems.filter((i) => i.lineItemId).length;

  const refresh = () => router.refresh();

  // The DTO carries the job flattened, not nested.
  const jobLabel = s.jobNumber ? (s.jobName ? `${s.jobNumber} · ${s.jobName}` : s.jobNumber) : s.name;

  if (uiVersion === "field" && capturing) {
    // A fixed overlay, not an inline panel: rendered in place it would sit
    // inside the page header and max-w-4xl gutter, so the camera would be a
    // letterboxed strip and 100dvh would simply overflow below the chrome.
    return (
      <div className="fixed inset-0 z-50 overflow-hidden bg-field-ground">
      <CapturePanel
        sessionId={s.id}
        jobLabel={jobLabel}
        onDone={() => {
          setCapturing(false);
          refresh();
        }}
        onItems={() => {
          setCapturing(false);
          setTab("items");
        }}
      />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {uiVersion === "field" && (
        // The one field surface built so far. The rest of this screen is still
        // the classic layout; it is replaced screen by screen rather than in a
        // single change nobody can review.
        <button
          onClick={() => setCapturing(true)}
          className="flex h-[112px] w-full items-center gap-4 rounded-[20px] bg-field-teal px-5 font-field text-left shadow-f-primary transition hover:bg-field-tealHover"
        >
          <span aria-hidden className="flex h-[62px] w-[62px] shrink-0 items-center justify-center rounded-full ring-4 ring-white">
            <span className="block h-[26px] w-[34px] rounded-[4px] border-[3px] border-white" />
          </span>
          <span>
            <span className="block text-f-24 font-bold text-white">Scan a receipt</span>
            <span className="block text-f-16" style={{ color: "#BFE8E2" }}>
              Point at it — it shoots itself
            </span>
          </span>
        </button>
      )}

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
