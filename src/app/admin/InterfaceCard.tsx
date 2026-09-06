"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UI_VERSIONS, type UiVersion } from "@/lib/settings";

/**
 * Which interface the site serves.
 *
 * A setting rather than a deploy, so reverting is immediate if the redesign
 * turns out not to suit how a crew actually works — and so anything the
 * redesign has not covered yet is still reachable.
 */
export default function InterfaceCard({ current }: { current: UiVersion }) {
  const router = useRouter();
  const [value, setValue] = useState<UiVersion>(current);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function choose(next: UiVersion) {
    if (next === value) return;
    const previous = value;
    setValue(next);
    setBusy(true);
    setSaved(false);
    setErr(null);

    let res: Response;
    try {
      res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uiVersion: next }),
      });
    } catch {
      // Offline, or the request refused outright. Without this the control
      // sits on "Saving..." for ever with an unhandled rejection behind it.
      setBusy(false);
      setValue(previous);
      setErr("Could not reach the server");
      return;
    }
    setBusy(false);

    if (!res.ok) {
      // Put the control back where it was rather than leaving it showing a
      // choice that was not saved.
      setValue(previous);
      const body = await res.json().catch(() => ({}));
      setErr(body.error ?? "Could not change the interface");
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <div className="card overflow-hidden">
      <div className="border-b border-line px-4 py-3">
        <span className="font-semibold">Interface</span>
        <p className="mt-1 text-sm text-muted">
          Which screens everyone sees. This applies to the whole site — it is not a per-person preference.
        </p>
      </div>
      <div className="space-y-2 p-4">
        {UI_VERSIONS.map((o) => (
          <label
            key={o.value}
            className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition ${
              value === o.value ? "border-brand bg-brand/5" : "border-line hover:border-brand/40"
            }`}
          >
            <input
              type="radio"
              name="ui-version"
              className="mt-1 h-4 w-4 accent-brand"
              checked={value === o.value}
              disabled={busy}
              onChange={() => void choose(o.value)}
            />
            <span>
              <span className="block font-medium">{o.label}</span>
              <span className="block text-sm text-muted">{o.description}</span>
            </span>
          </label>
        ))}
        <div className="flex items-center gap-3 pt-1">
          {busy && <span className="text-sm text-muted">Saving…</span>}
          {saved && !busy && <span className="text-sm text-brand">Saved.</span>}
          {err && <span className="text-sm text-red-300">{err}</span>}
        </div>
      </div>
    </div>
  );
}
