"use client";

import { useRef, useState } from "react";
import type { ReceiptDTO, SessionDTO } from "@/lib/dto";
import { formatCents, parseToCents } from "@/lib/money";

export default function ReceiptPanel({ session, onChange }: { session: SessionDTO; onChange: () => void }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    const form = new FormData();
    form.append("image", file);
    const res = await fetch(`/api/sessions/${session.id}/receipts`, { method: "POST", body: form });
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
    if (res.ok) {
      // A scanned PDF or a failed OCR run still returns 201 with the receipt
      // stored and a `message` explaining what to do. Treating every 2xx as
      // silent success threw that explanation away, leaving the user with a
      // blank receipt and no idea why.
      const data = await res.json().catch(() => ({}));
      if (data.status === "failed" && data.message) setError(data.message);
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
        {/* Two inputs rather than one. `capture` forces the camera on mobile,
            which makes choosing a saved PDF impossible, and accept="image/*"
            would hide PDFs from the picker anyway. */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
            e.target.value = "";
          }}
        />
        <input
          ref={uploadRef}
          type="file"
          accept="image/*,application/pdf,.pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
            // Reset so picking the same file twice still fires a change.
            e.target.value = "";
          }}
        />
        <div className="grid gap-2 sm:grid-cols-2">
          <button className="btn-primary" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? "Processing…" : "📷 Scan a receipt"}
          </button>
          <button className="btn-secondary" disabled={uploading} onClick={() => uploadRef.current?.click()}>
            {uploading ? "Processing…" : "📄 Upload a file"}
          </button>
        </div>
        <p className="mt-2 text-center text-xs text-muted">
          Photograph a paper receipt, or upload a PDF from an online purchase. PDFs are read directly from
          their text, so the details come out exact rather than guessed.
        </p>
        {error && <p className="mt-2 text-center text-sm text-red-300">{error}</p>}
      </div>

      {session.receipts.length === 0 ? (
        <div className="card p-8 text-center text-muted">No receipts yet.</div>
      ) : (
        session.receipts.map((r) => <ReceiptCard key={r.id} receipt={r} onChange={onChange} />)
      )}
    </div>
  );
}

function ReceiptCard({ receipt, onChange }: { receipt: ReceiptDTO; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  // Edit buffers
  const [merchant, setMerchant] = useState(receipt.merchant ?? "");
  const [date, setDate] = useState(receipt.purchaseDate ? receipt.purchaseDate.slice(0, 10) : "");
  const [paymentRaw, setPaymentRaw] = useState(receipt.paymentRaw ?? "");
  const [total, setTotal] = useState(receipt.total != null ? (receipt.total / 100).toFixed(2) : "");
  const [items, setItems] = useState(
    receipt.lineItems.map((li) => ({
      description: li.description,
      quantity: li.quantity,
      amount: (li.amount / 100).toFixed(2),
    })),
  );

  const verified = receipt.status === "verified";

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
    <div className="card overflow-hidden">
      <div className="flex gap-4 p-4">
        {receipt.imagePath &&
          (receipt.imagePath.toLowerCase().endsWith(".pdf") ? (
            <a
              href={receipt.imagePath}
              className="flex h-24 w-20 shrink-0 flex-col items-center justify-center rounded border border-line bg-panel2 text-center text-xs text-muted hover:text-brand"
            >
              <span className="text-2xl" aria-hidden>📄</span>
              PDF
            </a>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={receipt.imagePath} alt="Receipt" className="h-24 w-20 shrink-0 rounded object-cover" />
          ))}
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
          receipt.lineItems.length === 0 ? (
            <p className="text-sm text-muted">No line items detected.</p>
          ) : (
            <ul className="divide-y divide-line">
              {receipt.lineItems.map((li) => (
                <li key={li.id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                  <span className="truncate">
                    {li.quantity > 1 && <span className="text-muted">{li.quantity}× </span>}
                    {li.description}
                    {li.linkedScannedItemId && (
                      <span className="ml-2 badge bg-brand/15 text-brand">🔗 linked</span>
                    )}
                  </span>
                  <span className="shrink-0 font-medium">{formatCents(li.amount)}</span>
                </li>
              ))}
            </ul>
          )
        ) : (
          <div className="space-y-2">
            {items.map((it, idx) => (
              <div key={idx} className="flex gap-2">
                <input
                  className="input flex-1"
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
                <button
                  type="button"
                  className="px-2 text-muted hover:text-red-300"
                  onClick={() => setItems((arr) => arr.filter((_, i) => i !== idx))}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setItems((arr) => [...arr, { description: "", quantity: 1, amount: "0.00" }])}
            >
              + Add line item
            </button>
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
