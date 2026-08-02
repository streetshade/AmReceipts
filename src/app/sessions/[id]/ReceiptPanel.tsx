"use client";

import { useRef, useState } from "react";
import type { ReceiptDTO, SessionDTO } from "@/lib/dto";
import { formatCents, parseToCents } from "@/lib/money";

// Two receipts in a session are flagged as a possible duplicate when they share
// merchant + purchase date + total — the usual "scanned twice" signature.
function duplicateIds(receipts: ReceiptDTO[]): Set<string> {
  const seen = new Map<string, string[]>();
  for (const r of receipts) {
    if (!r.merchant || r.total == null || !r.purchaseDate) continue;
    const key = `${r.merchant.trim().toLowerCase()}|${r.purchaseDate.slice(0, 10)}|${r.total}`;
    seen.set(key, [...(seen.get(key) ?? []), r.id]);
  }
  const dupes = new Set<string>();
  for (const ids of seen.values()) if (ids.length > 1) ids.forEach((id) => dupes.add(id));
  return dupes;
}

export default function ReceiptPanel({ session, onChange }: { session: SessionDTO; onChange: () => void }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const dupes = duplicateIds(session.receipts);

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    const form = new FormData();
    form.append("image", file);
    const res = await fetch(`/api/sessions/${session.id}/receipts`, { method: "POST", body: form });
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
    if (res.ok) {
      onChange();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Upload failed");
    }
  }

  return (
    <div className="space-y-4">
      {/* Capture */}
      <div className="card p-4">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
          }}
        />
        <button className="btn-primary w-full" disabled={uploading} onClick={() => fileRef.current?.click()}>
          {uploading ? "Processing receipt…" : "📷 Scan a receipt"}
        </button>
        <p className="mt-2 text-center text-xs text-muted">
          Take a photo of a receipt. It’s OCR-processed for merchant, date, line items, tax and payment method.
          Tap a receipt’s image to view it full-size and check the details.
        </p>
        {error && <p className="mt-2 text-center text-sm text-red-300">{error}</p>}
      </div>

      {session.receipts.length === 0 ? (
        <div className="card p-8 text-center text-muted">No receipts yet.</div>
      ) : (
        session.receipts.map((r) => (
          <ReceiptCard
            key={r.id}
            receipt={r}
            isDuplicate={dupes.has(r.id)}
            onChange={onChange}
            onViewImage={setLightbox}
          />
        ))
      )}

      {/* Full-size image viewer */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightbox(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="Receipt" className="max-h-full max-w-full rounded shadow-2xl" />
          <button
            className="absolute right-4 top-4 rounded-full bg-black/60 px-3 py-1 text-sm text-white"
            onClick={() => setLightbox(null)}
          >
            Close ✕
          </button>
        </div>
      )}
    </div>
  );
}

interface EditItem {
  description: string;
  quantity: number;
  amount: string;
  kind: "item" | "tax";
}

function ReceiptCard({
  receipt,
  isDuplicate,
  onChange,
  onViewImage,
}: {
  receipt: ReceiptDTO;
  isDuplicate: boolean;
  onChange: () => void;
  onViewImage: (path: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  // Edit buffers
  const [merchant, setMerchant] = useState(receipt.merchant ?? "");
  const [date, setDate] = useState(receipt.purchaseDate ? receipt.purchaseDate.slice(0, 10) : "");
  const [paymentRaw, setPaymentRaw] = useState(receipt.paymentRaw ?? "");
  const [total, setTotal] = useState(receipt.total != null ? (receipt.total / 100).toFixed(2) : "");
  const [items, setItems] = useState<EditItem[]>(
    receipt.lineItems.map((li) => ({
      description: li.description,
      quantity: li.quantity,
      amount: (li.amount / 100).toFixed(2),
      kind: li.kind === "tax" ? "tax" : "item",
    })),
  );

  const verified = receipt.status === "verified";

  // Pre-tax vs tax breakdown, from the line items themselves.
  const itemsSubtotal = receipt.lineItems.filter((li) => li.kind !== "tax").reduce((s, li) => s + li.amount, 0);
  const taxTotal = receipt.lineItems.filter((li) => li.kind === "tax").reduce((s, li) => s + li.amount, 0);
  const hasLines = receipt.lineItems.length > 0;

  async function save() {
    setBusy(true);
    const body = {
      merchant: merchant || null,
      purchaseDate: date ? new Date(date + "T00:00:00Z").toISOString() : null,
      paymentRaw: paymentRaw || null,
      total: parseToCents(total),
      status: "verified" as const,
      lineItems: items
        .filter((i) => i.description.trim())
        .map((i) => ({
          description: i.description.trim(),
          quantity: Math.max(1, Number(i.quantity) || 1),
          amount: parseToCents(i.amount) ?? 0,
          kind: i.kind,
        })),
    };
    const res = await fetch(`/api/receipts/${receipt.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (res.ok) {
      setEditing(false);
      onChange();
    }
  }

  async function remove() {
    if (!confirm("Delete this receipt?")) return;
    setBusy(true);
    await fetch(`/api/receipts/${receipt.id}`, { method: "DELETE" });
    onChange();
  }

  async function verify() {
    setBusy(true);
    await fetch(`/api/receipts/${receipt.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "verified" }),
    });
    setBusy(false);
    onChange();
  }

  return (
    <div className={`card overflow-hidden ${isDuplicate ? "border-amber-500/50" : ""}`}>
      {isDuplicate && (
        <div className="flex items-center gap-2 bg-amber-500/10 px-4 py-2 text-sm text-amber-300">
          ⚠ Possible duplicate — another receipt in this session has the same merchant, date and total.
        </div>
      )}
      <div className="flex gap-4 p-4">
        {receipt.imagePath && (
          <button
            type="button"
            onClick={() => onViewImage(receipt.imagePath!)}
            className="group relative shrink-0"
            title="View full size"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={receipt.imagePath} alt="Receipt" className="h-24 w-20 rounded object-cover" />
            <span className="absolute inset-0 flex items-center justify-center rounded bg-black/0 text-xs text-transparent transition group-hover:bg-black/40 group-hover:text-white">
              View
            </span>
          </button>
        )}
        <div className="min-w-0 flex-1">
          {!editing ? (
            <>
              <div className="flex items-center gap-2">
                <h3 className="truncate font-semibold">{receipt.merchant ?? "Unknown merchant"}</h3>
                <span
                  className={`badge ${verified ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}
                >
                  {verified ? "verified" : receipt.status}
                </span>
              </div>
              <p className="text-sm text-muted">
                {receipt.purchaseDate ? new Date(receipt.purchaseDate).toLocaleDateString() : "No date"}
                {receipt.paymentLabel && <> · {receipt.paymentLabel}</>}
              </p>
              <div className="mt-1 text-lg font-semibold">{formatCents(receipt.total)}</div>
            </>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <label className="label">Merchant</label>
                <input className="input" value={merchant} onChange={(e) => setMerchant(e.target.value)} />
              </div>
              <div>
                <label className="label">Date</label>
                <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div>
                <label className="label">Payment method</label>
                <input
                  className="input"
                  placeholder="VISA ****1234 / CASH"
                  value={paymentRaw}
                  onChange={(e) => setPaymentRaw(e.target.value)}
                />
              </div>
              <div>
                <label className="label">Total</label>
                <input className="input" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Line items */}
      <div className="border-t border-line px-4 py-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Line items</div>
        {!editing ? (
          !hasLines ? (
            <p className="text-sm text-muted">No line items detected.</p>
          ) : (
            <>
              <ul className="divide-y divide-line">
                {receipt.lineItems.map((li) => (
                  <li key={li.id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                    <span className="truncate">
                      {li.quantity > 1 && <span className="text-muted">{li.quantity}× </span>}
                      {li.description}
                      {li.kind === "tax" && <span className="ml-2 badge bg-gold/15 text-gold">tax</span>}
                      {li.linkedScannedItemId && (
                        <span className="ml-2 badge bg-brand/15 text-brand">🔗 linked</span>
                      )}
                    </span>
                    <span className="shrink-0 font-medium">{formatCents(li.amount)}</span>
                  </li>
                ))}
              </ul>
              {/* Pre-tax / tax / total breakdown */}
              <div className="mt-2 space-y-0.5 border-t border-line pt-2 text-sm">
                <div className="flex justify-between text-muted">
                  <span>Subtotal (pre-tax)</span>
                  <span>{formatCents(itemsSubtotal)}</span>
                </div>
                <div className="flex justify-between text-muted">
                  <span>Tax</span>
                  <span>{formatCents(taxTotal)}</span>
                </div>
                <div className="flex justify-between font-semibold">
                  <span>Total</span>
                  <span>{formatCents(receipt.total ?? itemsSubtotal + taxTotal)}</span>
                </div>
              </div>
            </>
          )
        ) : (
          <div className="space-y-2">
            {items.map((it, idx) => (
              <div key={idx} className="flex flex-wrap items-center gap-2">
                <input
                  className="input min-w-[8rem] flex-1"
                  value={it.description}
                  onChange={(e) =>
                    setItems((arr) => arr.map((x, i) => (i === idx ? { ...x, description: e.target.value } : x)))
                  }
                />
                <input
                  className="input w-14"
                  inputMode="numeric"
                  value={it.quantity}
                  onChange={(e) =>
                    setItems((arr) => arr.map((x, i) => (i === idx ? { ...x, quantity: Number(e.target.value) } : x)))
                  }
                />
                <input
                  className="input w-24"
                  inputMode="decimal"
                  value={it.amount}
                  onChange={(e) =>
                    setItems((arr) => arr.map((x, i) => (i === idx ? { ...x, amount: e.target.value } : x)))
                  }
                />
                <label className="flex items-center gap-1 text-xs text-muted" title="Mark this line as tax">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-gold"
                    checked={it.kind === "tax"}
                    onChange={(e) =>
                      setItems((arr) =>
                        arr.map((x, i) => (i === idx ? { ...x, kind: e.target.checked ? "tax" : "item" } : x)),
                      )
                    }
                  />
                  tax
                </label>
                <button
                  type="button"
                  className="px-2 text-muted hover:text-red-300"
                  onClick={() => setItems((arr) => arr.filter((_, i) => i !== idx))}
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setItems((arr) => [...arr, { description: "", quantity: 1, amount: "0.00", kind: "item" }])}
              >
                + Add line item
              </button>
              {!items.some((i) => i.kind === "tax") && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() =>
                    setItems((arr) => [
                      ...arr,
                      { description: "Tax", quantity: 1, amount: (receipt.tax != null ? receipt.tax / 100 : 0).toFixed(2), kind: "tax" },
                    ])
                  }
                >
                  + Add tax line
                </button>
              )}
            </div>
          </div>
        )}

        {/* Raw OCR text — helps spot anything the parser missed (e.g. a line
            wrapped across two rows) so you can add it manually above. */}
        {receipt.rawText && (
          <div className="mt-3">
            <button className="text-xs text-muted hover:text-content" onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? "Hide" : "Show"} raw OCR text
            </button>
            {showRaw && (
              <pre className="mt-1 max-h-48 overflow-auto rounded bg-panel2 p-2 text-xs text-muted whitespace-pre-wrap">
                {receipt.rawText}
              </pre>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 border-t border-line bg-panel2 px-4 py-2">
        {editing ? (
          <>
            <button className="btn-secondary" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
            <button className="btn-primary" onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save & verify"}
            </button>
          </>
        ) : (
          <>
            <button className="btn-danger" onClick={remove} disabled={busy}>
              Delete
            </button>
            {!verified && (
              <button className="btn-secondary" onClick={verify} disabled={busy}>
                Verify
              </button>
            )}
            <button className="btn-secondary" onClick={() => setEditing(true)}>
              Edit
            </button>
          </>
        )}
      </div>
    </div>
  );
}
