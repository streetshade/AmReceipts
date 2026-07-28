"use client";

import { useState } from "react";
import type { ScannedItemDTO, SessionDTO } from "@/lib/dto";
import { formatCents } from "@/lib/money";
import BarcodeScanner from "@/components/BarcodeScanner";

interface Preview {
  barcode: string;
  found: boolean;
  name: string;
  brand: string | null;
  imageUrl: string | null;
  price: number | null;
  rateLimited: boolean;
}

const RATE_LIMIT_MSG =
  "Daily lookup limit reached — the item was still added; its product details will be fetched automatically within 24 hours.";

export default function BarcodePanel({ session, onChange }: { session: SessionDTO; onChange: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [looking, setLooking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function onDetected(code: string) {
    setLooking(true);
    setNote(null);
    const res = await fetch(`/api/barcodes/${encodeURIComponent(code)}`);
    setLooking(false);
    if (!res.ok) {
      setNote("Lookup failed.");
      return;
    }
    const data = await res.json();
    if (data.found) {
      setPreview({
        barcode: data.product.barcode,
        found: true,
        name: data.product.name,
        brand: data.product.brand,
        imageUrl: data.product.imageUrl,
        price: data.product.price,
        rateLimited: false,
      });
    } else {
      setPreview({
        barcode: code,
        found: false,
        name: `Unknown item (${code})`,
        brand: null,
        imageUrl: null,
        price: null,
        rateLimited: Boolean(data.rateLimited),
      });
    }
    setQuantity(1);
  }

  async function add() {
    if (!preview) return;
    setAdding(true);
    const res = await fetch(`/api/sessions/${session.id}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ barcode: preview.barcode, quantity }),
    });
    setAdding(false);
    if (res.ok) {
      const data = await res.json();
      setNote(
        data.rateLimited
          ? RATE_LIMIT_MSG
          : data.matched
            ? "Added and linked to a receipt line item."
            : "Added to session.",
      );
      setPreview(null);
      onChange();
    } else {
      const data = await res.json().catch(() => ({}));
      setNote(data.error ?? "Could not add item.");
    }
  }

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <BarcodeScanner onDetected={onDetected} />
        {looking && <p className="mt-2 text-center text-sm text-muted">Looking up…</p>}
      </div>

      {/* Product preview + quantity prompt */}
      {preview && (
        <div className="card p-4">
          <div className="flex gap-4">
            <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded bg-panel2">
              {preview.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={preview.imageUrl} alt={preview.name} className="h-full w-full object-contain" />
              ) : (
                <span className="text-3xl">📦</span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold">{preview.name}</h3>
              {preview.brand && <p className="text-sm text-muted">{preview.brand}</p>}
              <p className="mt-0.5 text-xs text-muted">Barcode {preview.barcode}</p>
              {preview.price != null && <p className="mt-1 text-sm">Ref. price {formatCents(preview.price)}</p>}
              {!preview.found && !preview.rateLimited && (
                <p className="mt-1 text-xs text-amber-300">Not in catalogue — added by barcode only.</p>
              )}
              {preview.rateLimited && (
                <p className="mt-1 text-xs text-gold">Daily lookup limit reached — details will be fetched within 24h.</p>
              )}
            </div>
          </div>
          <div className="mt-4 flex items-end gap-3">
            <div>
              <label className="label">Quantity</label>
              <div className="flex items-center gap-2">
                <button className="btn-secondary h-9 w-9 p-0" onClick={() => setQuantity((q) => Math.max(1, q - 1))}>
                  −
                </button>
                <input
                  className="input w-16 text-center"
                  inputMode="numeric"
                  value={quantity}
                  onChange={(e) => setQuantity(Math.max(1, Number(e.target.value.replace(/\D/g, "")) || 1))}
                />
                <button className="btn-secondary h-9 w-9 p-0" onClick={() => setQuantity((q) => q + 1)}>
                  +
                </button>
              </div>
            </div>
            <button className="btn-primary flex-1" onClick={add} disabled={adding}>
              {adding ? "Adding…" : "Add to session"}
            </button>
            <button className="btn-secondary" onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {note && <p className="text-center text-sm text-muted">{note}</p>}

      {/* Scanned items list */}
      {session.scannedItems.length === 0 ? (
        <div className="card p-8 text-center text-muted">No items scanned yet.</div>
      ) : (
        <ul className="space-y-2">
          {session.scannedItems.map((item) => (
            <ScannedItemRow key={item.id} item={item} session={session} onChange={onChange} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ScannedItemRow({
  item,
  session,
  onChange,
}: {
  item: ScannedItemDTO;
  session: SessionDTO;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);

  // Line items across the session's receipts that are free to link (plus the one
  // currently linked to this item).
  const options = session.receipts
    .flatMap((r) => r.lineItems)
    .filter((li) => !li.linkedScannedItemId || li.id === item.lineItemId);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    await fetch(`/api/scanned-items/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    onChange();
  }

  async function remove() {
    setBusy(true);
    await fetch(`/api/scanned-items/${item.id}`, { method: "DELETE" });
    onChange();
  }

  return (
    <li className="card flex items-center gap-3 p-3">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-panel2">
        {item.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.imageUrl} alt={item.name} className="h-full w-full object-contain" />
        ) : (
          <span className="text-xl">📦</span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{item.name}</div>
        <div className="text-xs text-muted">Barcode {item.barcode}</div>
        <div className="mt-1 flex items-center gap-2">
          <label className="text-xs text-muted">Link:</label>
          <select
            className="rounded border border-line bg-panel2 px-1 py-0.5 text-xs text-content"
            value={item.lineItemId ?? ""}
            disabled={busy}
            onChange={(e) => patch({ lineItemId: e.target.value || null })}
          >
            <option value="">— none —</option>
            {options.map((li) => (
              <option key={li.id} value={li.id}>
                {li.description} ({formatCents(li.amount)})
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-1">
          <button
            className="h-7 w-7 rounded border border-line text-muted"
            disabled={busy}
            onClick={() => patch({ quantity: Math.max(1, item.quantity - 1) })}
          >
            −
          </button>
          <span className="w-6 text-center text-sm">{item.quantity}</span>
          <button
            className="h-7 w-7 rounded border border-line text-muted"
            disabled={busy}
            onClick={() => patch({ quantity: item.quantity + 1 })}
          >
            +
          </button>
        </div>
        <button className="text-xs text-muted hover:text-red-300" disabled={busy} onClick={remove}>
          Remove
        </button>
      </div>
    </li>
  );
}
