"use client";

// Review captures — confirm what the reader got, flagging only what's doubtful.
//
// This screen sits between a burst of photographs and the visit, and its job is
// to be skippable. Most receipts read cleanly; the footer button says "All good
// — back to the visit" because that is what the technician should be able to
// press without reading anything. The warnings are for the minority, and
// `src/lib/receiptQuality.ts` is deliberately strict about what earns one.
//
// The screen is built from the PHOTOGRAPHS, not from the receipts. A capture
// still sitting in the offline queue has no receipt yet, and it still gets a
// row, a number and a place in the counts - otherwise a technician who
// photographed three receipts with no signal would be shown "$0.00" and a
// button reading "All good".

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";
import { entryConcerns, summariseBurst, type BurstEntry, type Concern } from "@/lib/receiptQuality";
import { flush, listPending, offlineQueueAvailable } from "@/lib/offlineQueue";
import { discardCapture, planDiscard } from "@/lib/captureDiscard";
import { isOnline } from "@/lib/online";
import type { ReceiptDTO } from "@/lib/dto";
import type { CaptureShot } from "@/lib/capture";

export default function ReviewCaptures({
  sessionId,
  captures,
  receipts,
  jobLabel,
  onBack,
  onOpen,
  onFinish,
  onDiscard,
}: {
  sessionId: string;
  captures: CaptureShot[];
  /** Every receipt on the visit; the burst is picked out of it by capture id. */
  receipts: ReceiptDTO[];
  jobLabel: string;
  /** Back to the camera. */
  onBack: () => void;
  onOpen: (receiptId: string) => void;
  /** Done here — back to the visit. */
  onFinish: () => void;
  /** A photograph was thrown away; take it out of the burst. */
  onDiscard: (captureId: string) => void;
}) {
  const router = useRouter();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * What is actually still waiting to be sent.
   *
   * A shot's own `status` is a snapshot taken by the camera screen, and that
   * screen is unmounted while this one is up - so an upload that was still in
   * flight when the user pressed Done goes on saying "Sending…" for ever. The
   * queue knows better, and this asks it.
   */
  const [queuedIds, setQueuedIds] = useState<Set<string> | null>(null);
  /**
   * Photographs the server refused outright while this screen was open.
   *
   * The flush removes a permanently rejected upload from the queue - a file too
   * large, a session that no longer exists - so it is neither queued nor a
   * receipt, and nothing else on this screen would ever mention it again. The
   * row would sit there promising to send a photograph that no longer exists.
   */
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(new Set());
  const readQueue = useCallback(async () => {
    if (!offlineQueueAvailable()) return;
    try {
      const rows = await listPending(sessionId);
      if (alive.current) setQueuedIds(new Set(rows.map((r) => r.id)));
    } catch {
      // A browser that refuses IndexedDB simply leaves the shots' own status in
      // place, which is what this screen used before.
    }
  }, [sessionId]);

  const byCapture = new Map(receipts.filter((r) => r.captureId).map((r) => [r.captureId as string, r]));
  const entries: BurstEntry[] = captures.map((shot) => {
    const receipt = byCapture.get(shot.id) ?? null;
    if (receipt) return { shot, receipt };
    if (rejectedIds.has(shot.id)) {
      return {
        shot: { ...shot, status: "failed" as const, message: "The server refused this photo — take it again" },
        receipt,
      };
    }
    // A row the camera already marked failed keeps that; it is the more
    // specific message of the two.
    if (queuedIds === null || shot.status === "failed") return { shot, receipt };
    return { shot: { ...shot, status: queuedIds.has(shot.id) ? "queued" : shot.status }, receipt };
  });
  const outstanding = entries.filter((e) => !e.receipt).length;

  const summary = summariseBurst(entries);
  const context = { entries };

  // A photograph queued offline becomes a receipt only once it is sent, so
  // regaining signal has to be able to fill the row in rather than leaving
  // "sends when you get signal" on screen for a receipt that arrived minutes
  // ago.
  //
  // The refresh happens ONLY when the flush actually sent something, which is
  // proof the server answered. An unconditional refresh here blanked the entire
  // app when there was no connection - see `src/lib/online.ts` - which on an
  // offline-first screen is the worst thing this code could do. The page does
  // not otherwise need it: every successful upload already triggers one, and
  // this component re-renders from its props when that lands.
  const [syncing, setSyncing] = useState(false);
  const sync = useCallback(async () => {
    if (!isOnline()) {
      await readQueue();
      return;
    }
    if (alive.current) setSyncing(true);
    try {
      if (offlineQueueAvailable()) {
        // The listener is the only notice a refused photograph ever gets: the
        // flush deletes it from the queue, so afterwards it is neither queued
        // nor a receipt and nothing would say what became of it.
        await flush((item, outcome) => {
          if (outcome === "rejected" && alive.current) {
            setRejectedIds((prev) => new Set(prev).add(item.id));
          }
        });
      }
      // A real request to our own server, and the page is refreshed only once
      // it comes back. `navigator.onLine` says nothing about a captive portal
      // or a dead cell, and a refresh in either state blanks the whole app -
      // so this asks for proof rather than taking the browser's word for it.
      // It also closes the race where an upload finished after the camera
      // screen was unmounted and its receipt is not in the props yet.
      const res = await fetch(`/api/sessions/${sessionId}`, { cache: "no-store" });
      if (res.ok) router.refresh();
    } catch {
      // Unreachable after all. The rows say what they know, and the queue keeps
      // the photographs.
    } finally {
      if (alive.current) setSyncing(false);
      await readQueue();
    }
  }, [router, sessionId, readQueue]);

  useEffect(() => {
    void sync();
  }, [sync]);

  useEffect(() => {
    if (outstanding === 0) return;
    const onOnline = () => void sync();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [outstanding, sync]);

  // Which row is asking "delete?". Deleting is not undoable - the paper is in
  // a bin and there is no second copy of the photograph - so it takes a second
  // tap, and disarms itself so a stray one cannot be left primed.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [discardError, setDiscardError] = useState<string | null>(null);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(null), 5000);
    return () => clearTimeout(t);
  }, [confirming]);

  const discard = useCallback(
    async (entry: BurstEntry) => {
      setConfirming(null);
      setDiscardError(null);
      const plan = planDiscard({
        receiptId: entry.receipt?.id ?? null,
        status: entry.shot.status,
        queued: queuedIds === null ? null : queuedIds.has(entry.shot.id),
      });
      const result = await discardCapture(sessionId, entry.shot.id, plan);
      if (!result.ok) {
        if (alive.current) setDiscardError(result.error ?? "Couldn't delete that one.");
        return;
      }
      // Taken out of the burst whether or not this screen is still up. The
      // burst belongs to the visit, not to this component, and a user who
      // pressed Back the instant they confirmed would otherwise find the
      // deleted photograph waiting for them on the camera strip.
      onDiscard(entry.shot.id);
      if (!alive.current) return;
      await readQueue();
      router.refresh();
    },
    [onDiscard, queuedIds, readQueue, router, sessionId],
  );

  const heading = captures.length === 1 ? "1 new receipt" : `${captures.length} new receipts`;
  const settled = summary.needsCheck === 0 && summary.waiting === 0;

  return (
    <div className="flex min-h-[100dvh] flex-col bg-field-ground font-field text-field-ink">
      <header className="flex items-center gap-3 border-b border-field-line bg-field-paper px-4 pb-3 pt-[calc(env(safe-area-inset-top)+14px)]">
        <button
          onClick={onBack}
          aria-label="Back to the camera"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] border-[1.5px] border-field-line text-[22px] leading-none"
        >
          ‹
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-f-13 font-semibold uppercase tracking-[.08em] text-field-muted">
            {jobLabel}
          </div>
          <h1 className="truncate text-f-23 font-bold">{heading}</h1>
        </div>
      </header>

      <div className="flex flex-col gap-3.5 px-5 pb-6 pt-4">
        <section className="rounded-[18px] border border-field-line bg-field-paper p-4">
          <p className="text-f-15 text-field-muted">Read from your photos</p>
          <p className="mt-0.5 text-f-27 font-bold tabular-nums">{formatCents(summary.totalCents)}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {summary.fine > 0 && (
              <span className="inline-flex items-center rounded-full border border-field-successLine bg-field-successFill px-3 py-1 text-f-14 font-semibold text-field-successText">
                {summary.fine} look{summary.fine === 1 ? "s" : ""} fine
              </span>
            )}
            {summary.needsCheck > 0 && (
              <span className="inline-flex items-center rounded-full border border-field-warnLine bg-field-warnFill px-3 py-1 text-f-14 font-semibold text-field-warnText">
                {summary.needsCheck} need{summary.needsCheck === 1 ? "s" : ""} a look
              </span>
            )}
            {summary.waiting > 0 && (
              <span className="inline-flex items-center rounded-full border border-field-line bg-field-ground px-3 py-1 text-f-14 font-semibold text-field-muted">
                {summary.waiting} still {syncing ? "sending" : "going"}
              </span>
            )}
          </div>
          {/*
            Each of these is said only when it is true, and they point in
            opposite directions: one says the figure is too small, the other
            that it may be too big. An earlier version showed the first
            whenever anything at all was flagged.
          */}
          {summary.missingTotals > 0 && (
            <p className="mt-2 text-f-15 text-field-muted">
              This leaves out {summary.missingTotals === 1 ? "one photo" : `${summary.missingTotals} photos`} with no
              total read yet.
            </p>
          )}
          {summary.duplicates > 0 && (
            <p className="mt-2 text-f-15 text-field-muted">
              It may also be counting {summary.duplicates === 1 ? "a receipt" : "receipts"} twice — check the ones
              marked below.
            </p>
          )}
        </section>

        {discardError && (
          <p role="alert" className="rounded-[14px] border border-field-dangerLine bg-field-dangerFill px-4 py-3 text-f-16">
            {discardError}
          </p>
        )}

        {entries.map((entry, i) => (
          <CaptureRow
            key={entry.shot.id}
            index={i + 1}
            entry={entry}
            concerns={entryConcerns(entry, context)}
            onOpen={onOpen}
            asking={confirming === entry.shot.id}
            onAsk={() => setConfirming(confirming === entry.shot.id ? null : entry.shot.id)}
            onConfirm={() => void discard(entry)}
          />
        ))}

        <button
          onClick={onFinish}
          className="mt-1 h-[60px] rounded-[16px] bg-field-teal text-f-18 font-bold text-white transition hover:bg-field-tealHover"
        >
          {settled ? "All good — back to the visit" : "Back to the visit"}
        </button>
        {summary.waiting > 0 && (
          <p className="text-center text-f-15 text-field-muted">
            Anything still going will send itself when you have signal.
          </p>
        )}
      </div>
    </div>
  );
}

function CaptureRow({
  index,
  entry,
  concerns,
  onOpen,
  asking,
  onAsk,
  onConfirm,
}: {
  index: number;
  entry: BurstEntry;
  concerns: Concern[];
  onOpen: (receiptId: string) => void;
  /** This row is asking whether to delete. */
  asking: boolean;
  onAsk: () => void;
  onConfirm: () => void;
}) {
  const receipt = entry.receipt;
  // The head of the list: the rules return them most important first, and one
  // warning that gets read beats three that do not.
  const concern = concerns[0];

  const body = (
    <>
      <Thumbnail entry={entry} index={index} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-f-19 font-bold">
          {receipt?.merchant?.trim() || (receipt ? "Unnamed shop" : "Not sent yet")}
        </span>
        <span className="block text-f-15 text-field-muted">{metaFor(receipt)}</span>
        {concern && (
          <span
            // A rectangle, not a pill: these messages wrap to two or three
            // lines on a phone, and a 999px radius on a three-line box bows the
            // text in at both ends.
            className={`mt-2 inline-flex items-start gap-2 rounded-[10px] border px-2.5 py-1 text-f-14 font-semibold ${
              concern.severity === "check"
                ? "border-field-warnLine bg-field-warnFill text-field-warnText"
                : "border-field-line bg-field-ground text-field-muted"
            }`}
          >
            {concern.severity === "check" && (
              <span aria-hidden className="mt-[7px] block h-2 w-2 shrink-0 rounded-full bg-field-warnDot" />
            )}
            {concern.message}
          </span>
        )}
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-f-21 font-bold tabular-nums">
          {receipt && receipt.total !== null ? formatCents(receipt.total) : "—"}
        </span>
        {receipt && <span className="block text-f-15 font-semibold text-field-teal">Check ›</span>}
      </span>
    </>
  );

  return (
    <div
      className={`rounded-[16px] border bg-field-paper transition ${
        asking ? "border-field-dangerLine" : "border-field-line"
      }`}
    >
      {/*
        A photograph with no receipt yet has nothing to open, but it is still
        shown - and still deletable - so the count in the heading and the number
        of rows agree.
      */}
      {receipt ? (
        <button onClick={() => onOpen(receipt.id)} className="flex w-full items-center gap-3 p-4 text-left">
          {body}
        </button>
      ) : (
        <div className="flex items-center gap-3 p-4">{body}</div>
      )}

      {/*
        Delete lives on the row as well as on the camera strip, because this is
        the screen where you can see WHY a photograph is bad - the duplicate
        warning, the total that would not read. Two taps, because it cannot be
        undone: the paper is in a bin and there is no second copy of the
        photograph anywhere.
      */}
      <div className="flex items-center justify-end gap-2 border-t border-field-rule px-4 py-2">
        {asking ? (
          <>
            <button
              onClick={onAsk}
              className="min-h-[44px] rounded-[12px] border-[1.5px] border-field-line px-4 text-f-16 font-semibold"
            >
              Keep
            </button>
            <button
              onClick={onConfirm}
              className="min-h-[44px] rounded-[12px] border-[1.5px] border-field-dangerLine bg-field-dangerFill px-4 text-f-16 font-bold"
            >
              Delete photo {index}
            </button>
          </>
        ) : (
          <button
            onClick={onAsk}
            aria-label={`Delete photo ${index}`}
            className="min-h-[44px] rounded-[12px] px-3 text-f-16 font-semibold text-field-muted hover:text-field-ink"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

/** The photograph itself where there is one, and an honest placeholder where there isn't. */
function Thumbnail({ entry, index }: { entry: BurstEntry; index: number }) {
  const isPdf = entry.receipt?.imagePath?.toLowerCase().endsWith(".pdf") ?? false;
  // The local preview first: it is already in memory, needs no request, and is
  // the only thing available for a capture still sitting in the queue.
  const src = entry.shot.preview || (isPdf ? "" : (entry.receipt?.imagePath ?? ""));

  return (
    <span className="relative block h-[66px] w-[54px] shrink-0 overflow-hidden rounded-[10px] border border-field-line">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center text-f-12 font-semibold text-field-muted"
          style={{ background: "repeating-linear-gradient(115deg,#EEF3F1 0 6px,#E3EBE8 6px 12px)" }}
        >
          {isPdf ? "PDF" : ""}
        </span>
      )}
      <span className="absolute left-1 top-1 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-field-ink text-f-11 font-bold text-white">
        {index}
      </span>
    </span>
  );
}

function metaFor(receipt: ReceiptDTO | null): string {
  // A row with no receipt says what is happening to it in its warning pill,
  // which is the one place that message belongs.
  if (!receipt) return "Nothing read yet";
  const when = receipt.purchaseDate
    ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(receipt.purchaseDate))
    : null;
  const parts = [
    when,
    receipt.paymentLabel ?? receipt.paymentRaw,
    receipt.lineItems.length > 0
      ? `${receipt.lineItems.length} line${receipt.lineItems.length === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean) as string[];
  return parts.length > 0 ? parts.join(" · ") : "No details read";
}
