"use client";

// Receipt detail — confirm one receipt, including its split taxes.
//
// The tax card is the reason this screen was redesigned. A single tax figure
// cannot carry a Canadian receipt: the office reclaims GST and HST but not PST,
// so the parts have to be visible and correctable. The split is filled in from
// the province as a DEFAULT — the paper in the user's hand is the authority,
// and the copy says so.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents, parseToCents, centsToInput } from "@/lib/money";
import { splitTax, taxLabel, regionsFor, type TaxCode } from "@/lib/tax";
import type { ReceiptDTO } from "@/lib/dto";

const COUNTRIES = [
  { code: "CA", label: "Canada" },
  { code: "US", label: "United States" },
];

interface EditableTax {
  code: TaxCode;
  ratePpm: number | null;
  /**
   * Held as the TEXT the user typed, not as cents.
   *
   * Parsing on every keystroke turned "1." into 100 and an empty box into
   * zero, then wrote the reformatted value back and moved the caret. Money is
   * parsed when it is read, not while it is being typed.
   */
  text: string;
}

// One money parser for the whole app, rather than a second one here that
// would drift from it.
const toCents = parseToCents;
const centsToText = centsToInput;

/**
 * The split to start from.
 *
 * Uses the country the screen DISPLAYS, not the stored one. A receipt with a
 * province but no country showed "Canada" while splitting as an unmapped US
 * sales tax, so the header and the rows disagreed on sight.
 */
function seedTaxes(receipt: ReceiptDTO): EditableTax[] {
  if (receipt.taxes.length > 0) {
    return receipt.taxes.map((t) => ({ code: t.code as TaxCode, ratePpm: t.ratePpm, text: centsToText(t.amount) }));
  }
  return splitTax(receipt.country ?? "CA", receipt.region, receipt.tax ?? 0).map((t) => ({
    code: t.code,
    ratePpm: t.ratePpm,
    text: centsToText(t.amount),
  }));
}

export default function ReceiptDetail({
  receipt,
  onBack,
}: {
  receipt: ReceiptDTO;
  onBack: () => void;
}) {
  const router = useRouter();
  const [country, setCountry] = useState(receipt.country ?? "CA");
  const [region, setRegion] = useState(receipt.region ?? "");
  // The total is editable. Without it a receipt whose OCR total was wrong, or
  // whose stored split no longer matched, could never be made to balance - and
  // "Looks right" stayed disabled with no way out.
  const [taxText, setTaxText] = useState(centsToText(receipt.tax ?? 0));
  const [taxes, setTaxes] = useState<EditableTax[]>(() => seedTaxes(receipt));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Re-seed when the receipt itself changes - after a save and refresh, or when
  // a different receipt is opened. Without this the editor kept the previous
  // receipt's figures while the rest of the screen showed the new one.
  useEffect(() => {
    setCountry(receipt.country ?? "CA");
    setRegion(receipt.region ?? "");
    setTaxText(centsToText(receipt.tax ?? 0));
    setTaxes(seedTaxes(receipt));
  }, [receipt]);

  const taxTotal = toCents(taxText);
  // A box that is mid-edit or nonsense is NOT zero. Treating it as zero made
  // the totals appear to balance and saved a nought over the user's figure.
  const allParsed = taxes.every((t) => toCents(t.text) !== null);
  const partsTotal = useMemo(
    () => taxes.reduce((sum, t) => sum + (toCents(t.text) ?? 0), 0),
    [taxes],
  );
  // Surfaced rather than silently corrected: if these disagree the user has
  // edited a figure and needs to see which way it is out.
  const balances = taxTotal !== null && allParsed && partsTotal === taxTotal;

  const regions = regionsFor(country);
  const regionLabel =
    regions.find((r) => r.code === region)?.label ?? (region || "Region not set");
  const countryLabel = COUNTRIES.find((c) => c.code === country)?.label ?? country;

  /** Re-derive the split when the place changes. */
  function changePlace(nextCountry: string, nextRegion: string) {
    setCountry(nextCountry);
    setRegion(nextRegion);
    setTaxes(
      splitTax(nextCountry, nextRegion || null, taxTotal ?? 0).map((t) => ({
        code: t.code,
        ratePpm: t.ratePpm,
        text: centsToText(t.amount),
      })),
    );
  }

  async function save(markVerified: boolean) {
    // The buttons are disabled when this does not hold, but a guard that lives
    // only in the UI stops being true the moment another caller appears.
    if (!balances || taxTotal === null) {
      setErr("The tax lines need to add up before this can be saved.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/receipts/${receipt.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          country: country || null,
          region: region || null,
          tax: taxTotal,
          taxes: taxes.map((t) => ({ code: t.code, ratePpm: t.ratePpm, amount: toCents(t.text) as number })),
          ...(markVerified ? { status: "verified" } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(body.error ?? "Could not save");
        return;
      }
      router.refresh();
      if (markVerified) onBack();
    } catch {
      setErr("No connection — try again in a moment");
    } finally {
      setBusy(false);
    }
  }

  const purchase = receipt.purchaseDate ? new Date(receipt.purchaseDate) : null;

  return (
    <div className="flex min-h-[100dvh] flex-col bg-field-ground font-field text-field-ink">
      <header className="flex items-center gap-3 border-b border-field-line bg-field-paper px-4 pb-3 pt-[calc(env(safe-area-inset-top)+14px)]">
        <button
          onClick={onBack}
          aria-label="Back to the job visit"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] border-[1.5px] border-field-line text-[22px] leading-none"
        >
          ‹
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-f-13 font-semibold uppercase tracking-[.08em] text-field-muted">Receipt</div>
          <div className="truncate text-f-19 font-bold">{receipt.merchant ?? "Unknown merchant"}</div>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-3.5 overflow-auto px-5 py-4">
        {/* Header card */}
        <section className="flex gap-4 rounded-[18px] border border-field-line bg-field-paper p-4">
          <div
            aria-hidden
            className="h-[104px] w-[82px] shrink-0 overflow-hidden rounded-[10px] border border-field-line"
            style={{ background: "repeating-linear-gradient(115deg,#EEF3F1 0 6px,#E3EBE8 6px 12px)" }}
          >
            {receipt.imagePath && !receipt.imagePath.toLowerCase().endsWith(".pdf") && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={receipt.imagePath} alt="" className="h-full w-full object-cover" />
            )}
          </div>
          <div className="min-w-0">
            <div className="text-f-14 font-semibold uppercase tracking-[.08em] text-field-muted">Total</div>
            <div className="text-f-36 font-bold tabular-nums">{formatCents(receipt.total)}</div>
            <div className="mt-1 text-f-17 text-field-muted">
              {purchase
                ? purchase.toLocaleString(undefined, {
                    weekday: "long",
                    day: "numeric",
                    month: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  })
                : "No date read"}
            </div>
            <div className="text-f-17 text-field-muted">{receipt.paymentLabel ?? receipt.paymentRaw ?? "Payment not read"}</div>
          </div>
        </section>

        {/* Tax */}
        <section className="rounded-[18px] border border-field-line bg-field-paper p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-f-14 font-semibold uppercase tracking-[.08em] text-field-muted">Tax</span>
            <span className="rounded-full border border-field-line bg-field-ground px-3 py-1 text-f-14 font-semibold text-field-muted">
              {region ? `${regionLabel}, ${countryLabel}` : countryLabel}
            </span>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-f-14 font-semibold text-field-muted">Country</span>
              <select
                className="h-12 w-full rounded-[12px] border-[1.5px] border-field-line bg-field-paper px-3 text-f-17"
                value={country}
                onChange={(e) => changePlace(e.target.value, "")}
              >
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>{c.label}</option>
                ))}
              </select>
            </label>
            {regions.length > 0 && (
              <label className="block">
                <span className="mb-1 block text-f-14 font-semibold text-field-muted">Province</span>
                <select
                  className="h-12 w-full rounded-[12px] border-[1.5px] border-field-line bg-field-paper px-3 text-f-17"
                  value={region}
                  onChange={(e) => changePlace(country, e.target.value)}
                >
                  <option value="">Choose…</option>
                  {regions.map((r) => (
                    <option key={r.code} value={r.code}>{r.label}</option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="mt-3">
            {taxes.length === 0 ? (
              <p className="text-f-17 text-field-muted">No tax read from this receipt.</p>
            ) : (
              taxes.map((t, i) => (
                <label key={t.code} className="flex items-center justify-between gap-3 py-2">
                  <span className="text-f-17">{taxLabel({ code: t.code, ratePpm: t.ratePpm ?? 0, amount: 0 })}</span>
                  <input
                    inputMode="decimal"
                    className="h-12 w-28 rounded-[12px] border-[1.5px] border-field-line bg-field-paper px-3 text-right text-f-18 font-semibold tabular-nums"
                    value={t.text}
                    onChange={(e) =>
                      setTaxes((prev) => prev.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))
                    }
                    onBlur={(e) => {
                      // Tidied when the user leaves the field, never mid-typing.
                      const cents = toCents(e.target.value);
                      if (cents !== null) {
                        setTaxes((prev) => prev.map((x, j) => (j === i ? { ...x, text: centsToText(cents) } : x)));
                      }
                    }}
                  />
                </label>
              ))
            )}
          </div>

          <label className="mt-2 flex items-center justify-between gap-3 border-t border-field-line pt-3">
            <span className="text-f-17 font-semibold">Tax on the receipt</span>
            <input
              inputMode="decimal"
              className="h-12 w-28 rounded-[12px] border-[1.5px] border-field-line bg-field-paper px-3 text-right text-f-18 font-bold tabular-nums"
              value={taxText}
              onChange={(e) => setTaxText(e.target.value)}
              onBlur={(e) => {
                const cents = toCents(e.target.value);
                if (cents !== null) setTaxText(centsToText(cents));
              }}
            />
          </label>

          {!balances && (
            <p role="status" className="mt-2 rounded-[12px] bg-field-warnFill px-3 py-2 text-f-17 text-field-warnText">
              {!allParsed
                ? "One of the tax amounts is not a number yet."
                : taxTotal === null
                ? "Enter the tax shown on the receipt."
                  : `These add up to ${formatCents(partsTotal)}, but the receipt's tax is ${formatCents(taxTotal)}.`}
            </p>
          )}

          <p className="mt-3 border-t border-field-line pt-3 text-f-17 text-field-muted">
            Split out because your office claims the input tax credits. Read off the receipt — change it if it&rsquo;s
            wrong.
          </p>
        </section>

        {/* Line items */}
        <section className="rounded-[18px] border border-field-line bg-field-paper p-4">
          <div className="text-f-14 font-semibold uppercase tracking-[.08em] text-field-muted">What was bought</div>
          {receipt.lineItems.length === 0 ? (
            <p className="mt-2 text-f-17 text-field-muted">Nothing itemised on this receipt.</p>
          ) : (
            <ul className="mt-2">
              {receipt.lineItems.map((li) => (
                <li key={li.id} className="flex items-start justify-between gap-3 border-b border-field-rule py-2.5 last:border-0">
                  <span className="min-w-0">
                    <span className="block text-f-17">{li.description}</span>
                    {li.linkedScannedItemId && (
                      <span className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-field-successLine bg-field-successFill px-2 py-0.5 text-f-13 font-semibold text-field-successText">
                        <span aria-hidden className="h-[7px] w-[7px] rounded-full bg-field-successText" />
                        Matched to a scanned item
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-f-17 font-semibold tabular-nums">{formatCents(li.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {err && (
          <p role="alert" className="rounded-[12px] bg-field-dangerFill px-3 py-2 text-f-17 text-field-warnText">
            {err}
          </p>
        )}
      </div>

      <div className="flex gap-3 border-t border-field-line bg-field-paper px-5 pb-[30px] pt-3.5">
        <button
          onClick={() => void save(false)}
          disabled={busy || !balances}
          title={balances ? undefined : "The tax lines need to add up first"}
          className="h-16 rounded-[16px] border-[1.5px] border-field-line px-6 text-f-18 font-semibold disabled:opacity-50"
        >
          Save
        </button>
        <button
          onClick={() => void save(true)}
          disabled={busy || !balances}
          title={balances ? undefined : "The tax lines need to add up first"}
          className="h-16 flex-1 rounded-[16px] bg-field-teal text-f-19 font-bold text-white transition hover:bg-field-tealHover disabled:opacity-50"
        >
          {busy ? "Saving…" : "Looks right"}
        </button>
      </div>
    </div>
  );
}
