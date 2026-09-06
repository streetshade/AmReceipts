"use client";

// Capture — the field app's primary screen.
//
// The brief: get a receipt photographed with gloves on, in sunlight, in a
// vehicle, without hunting for a button. So capture is automatic by default and
// the shutter stays available for the crumpled, glossy and badly-lit ones.
//
// HONEST NOTE ON "AUTO". The design says auto-capture fires "on edge
// detection". What this implements is STABILITY detection: successive frames
// are compared and, once the picture stops changing, the countdown starts.
// That is a genuine signal - it is what stops it firing while the phone is
// being moved into place - but it is not the same as recognising a document,
// and it will happily photograph a steady tabletop. Real edge detection needs a
// vision model or an OpenCV build; this is the honest approximation until then,
// and the shutter covers what it misses.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";
import { enqueue, flush, listPending, offlineQueueAvailable } from "@/lib/offlineQueue";

/**
 * 2 -> 1 -> fire, at 550ms: 1.65s nominal.
 *
 * The digit shown is derived from a monotonic DEADLINE rather than counted off
 * interval callbacks, because setInterval drifts under main-thread load and a
 * throttled tab can stretch three ticks well past the 2s the design allows.
 */
const TICK_MS = 550;
const COUNTDOWN_MS = TICK_MS * 3;
/** Below this mean per-pixel difference the picture counts as held still. */
const STILL_THRESHOLD = 6;
/** How long to wait after a shot before arming again, so one receipt is not shot twice. */
const REARM_MS = 1400;

interface Shot {
  id: string;
  /** Object URL for the thumbnail. Revoked on unmount. */
  preview: string;
  status: "uploading" | "read" | "queued" | "failed";
  totalCents: number | null;
  merchant: string | null;
  message?: string;
}

export default function CapturePanel({
  sessionId,
  jobLabel,
  onDone,
  onItems,
}: {
  sessionId: string;
  jobLabel: string;
  onDone: () => void;
  onItems: () => void;
}) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [auto, setAuto] = useState(true);
  const [hold, setHold] = useState<number | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [queued, setQueued] = useState(0);

  // Kept in refs, not state: the analysis loop runs every frame and must not
  // re-render the component or capture a stale closure.
  const lastFrame = useRef<ImageData | null>(null);
  const stillSince = useRef<number | null>(null);
  const armedAt = useRef<number>(0);
  const busy = useRef(false);
  const deadline = useRef<number | null>(null);

  // --- camera ------------------------------------------------------------
  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // The rear camera, and a resolution high enough for the reader
          // without shipping a 12MP frame over a job-site connection.
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1600 }, height: { ideal: 1200 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          try {
            await videoRef.current.play();
          } catch {
            // Autoplay refused. Claiming `streaming` here would leave the
            // shutter pressing a dead video instead of offering the picker.
            if (!cancelled) setCameraError("Camera could not start — use the button below to choose a photo.");
            return;
          }
          if (!cancelled) setStreaming(true);
        }
      } catch {
        // No camera, or permission refused. The file picker still works, so
        // this degrades to "choose a photo" rather than a dead screen.
        setCameraError("No camera available — use the button below to choose a photo.");
      }
    })();

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // --- upload ------------------------------------------------------------
  const upload = useCallback(
    async (blob: Blob, filename: string) => {
      const id = crypto.randomUUID();
      const preview = URL.createObjectURL(blob);
    previews.current.push(preview);
      setShots((prev) => [...prev, { id, preview, status: "uploading", totalCents: null, merchant: null }]);

      const form = new FormData();
      form.append("image", blob, filename);
      try {
        const res = await fetch(`/api/sessions/${sessionId}/receipts`, { method: "POST", body: form });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setShots((p) => p.map((s) => (s.id === id ? { ...s, status: "failed", message: data.error ?? "Upload failed" } : s)));
          return;
        }
        // A scanned PDF or a failed read still stores the receipt and returns a
        // message: surfaced on the tile rather than thrown away.
        const r = data.receipt ?? data;
        setShots((p) =>
          p.map((s) =>
            s.id === id
              ? {
                  ...s,
                  status: r.status === "failed" ? "failed" : "read",
                  totalCents: typeof r.total === "number" ? r.total : null,
                  merchant: r.merchant ?? null,
                  message: data.message,
                }
              : s,
          ),
        );
        router.refresh();
      } catch {
        // Genuinely durable, not a reassuring label on a Blob in memory: the
        // photo goes to IndexedDB and is retried when the connection returns.
        // The paper receipt is already in a bin by now.
        if (offlineQueueAvailable()) {
          try {
            await enqueue({ id, sessionId, filename, blob, capturedAt: Date.now() });
            setShots((p) => p.map((s) => (s.id === id ? { ...s, status: "queued", message: "Saved — sends when you get signal" } : s)));
            return;
          } catch {
            /* fall through to the honest failure below */
          }
        }
        setShots((p) =>
          p.map((s) => (s.id === id ? { ...s, status: "failed", message: "Could not save — try again in a moment" } : s)),
        );
      }
    },
    [sessionId, router],
  );

  const shoot = useCallback(async () => {
    if (busy.current) return;
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;

    busy.current = true;
    setHold(null);
    deadline.current = null;
    // Cleared here, not just in the watcher: otherwise the phone is still
    // "held still" the instant the shot completes and the next countdown
    // starts immediately, photographing the same receipt again.
    stillSince.current = null;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.9));

    // The shutter is free again as soon as the frame exists. Holding it through
    // the upload meant every press during a slow connection was discarded -
    // exactly when a user presses hardest.
    armedAt.current = Date.now();
    busy.current = false;

    if (blob) void upload(blob, `receipt-${Date.now()}.jpg`);
  }, [upload]);

  // --- stability watch ---------------------------------------------------
  useEffect(() => {
    if (!auto || !streaming) {
      setHold(null);
      stillSince.current = null;
      return;
    }
    let raf = 0;
    const canvas = canvasRef.current ?? document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const video = videoRef.current;
      if (!ctx || !video || video.videoWidth === 0 || busy.current) return;
      if (Date.now() - armedAt.current < REARM_MS) return;

      // Downscaled to 64x48 on purpose: comparing full frames every tick would
      // cost more than the signal is worth, and stability survives the scaling.
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const prev = lastFrame.current;
      lastFrame.current = frame;
      if (!prev) return;

      let diff = 0;
      for (let i = 0; i < frame.data.length; i += 4) {
        diff += Math.abs(frame.data[i] - prev.data[i]);
      }
      const mean = diff / (frame.data.length / 4);

      if (mean < STILL_THRESHOLD) {
        if (stillSince.current === null) stillSince.current = Date.now();
      } else {
        stillSince.current = null;
        setHold(null);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [auto, streaming]);

  // --- countdown ---------------------------------------------------------
  useEffect(() => {
    if (!auto || !streaming) return;
    const timer = setInterval(() => {
      if (busy.current || stillSince.current === null) {
        deadline.current = null;
        setHold(null);
        return;
      }
      if (deadline.current === null) deadline.current = Date.now() + COUNTDOWN_MS;

      const left = deadline.current - Date.now();
      if (left <= 0) {
        void shoot();
        return;
      }
      // Derived from the clock, so a stalled tick shortens the display rather
      // than extending the countdown past its budget.
      setHold(Math.max(1, Math.ceil(left / TICK_MS) - 1));
    }, 120);
    return () => clearInterval(timer);
  }, [auto, streaming, shoot]);

  // Held in a ref and released only on unmount. Depending on `shots` meant the
  // cleanup ran on every status change and revoked URLs that the very next
  // render was still displaying - thumbnails went blank the moment an upload
  // finished.
  const previews = useRef<string[]>([]);
  useEffect(() => () => previews.current.forEach(URL.revokeObjectURL), []);

  // Retry anything left over from a previous visit, and again whenever the
  // connection comes back.
  useEffect(() => {
    if (!offlineQueueAvailable()) return;
    const run = () => {
      void flush().then(({ sent }) => {
        if (sent > 0) router.refresh();
        void listPending(sessionId).then((p) => setQueued(p.length));
      });
    };
    run();
    window.addEventListener("online", run);
    return () => window.removeEventListener("online", run);
  }, [router, sessionId]);

  const readCount = shots.filter((s) => s.status === "read").length;

  return (
    <div className="flex min-h-[100dvh] flex-col bg-field-ground font-field text-field-ink">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-field-line bg-field-paper px-4 pb-3 pt-[52px]">
        <button
          onClick={onDone}
          aria-label="Back to the job visit"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] border-[1.5px] border-field-line text-[22px] leading-none text-field-ink"
        >
          ‹
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-f-13 font-semibold uppercase tracking-[.08em] text-field-muted">Logging to</div>
          <div className="truncate text-f-19 font-bold">{jobLabel}</div>
        </div>
        <button
          onClick={onItems}
          className="flex h-12 items-center gap-2 rounded-[14px] border-[1.5px] border-field-line px-3 text-f-16 font-semibold"
        >
          <span
            aria-hidden
            className="h-[15px] w-[22px]"
            style={{ background: "repeating-linear-gradient(90deg,#46605A 0 2.5px,transparent 2.5px 5px)" }}
          />
          Items
        </button>
      </header>

      {/* Camera */}
      <div
        className="relative flex flex-1 flex-col"
        style={{ background: "repeating-linear-gradient(135deg,#12211E 0 10px,#0E1A18 10px 20px)" }}
      >
        <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-cover" />
        <canvas ref={canvasRef} className="hidden" />

        <div className="relative z-10 px-0 pb-1 pt-4 text-center font-mono text-f-14 text-field-mutedDark">
          {cameraError ? "camera unavailable" : streaming ? "live camera feed" : "starting camera…"}
        </div>

        <div className="relative z-10 flex flex-1 items-center justify-center">
          <div
            className={`relative w-[258px] max-h-[290px] h-full rounded-[12px] ${
              auto ? "border-[5px] border-field-accent shadow-f-scrim" : "shadow-f-scrim"
            }`}
          >
            {auto ? (
              <div
                aria-hidden
                className="absolute inset-x-0 top-0 h-12 animate-f-sweep motion-reduce:animate-none"
                style={{ background: "linear-gradient(180deg,rgba(34,224,199,0),rgba(34,224,199,.5))" }}
              />
            ) : (
              // Manual: four corner brackets rather than a full frame.
              <>
                <span className="absolute left-0 top-0 h-[52px] w-[52px] border-l-[5px] border-t-[5px] border-white" />
                <span className="absolute right-0 top-0 h-[52px] w-[52px] border-r-[5px] border-t-[5px] border-white" />
                <span className="absolute bottom-0 left-0 h-[52px] w-[52px] border-b-[5px] border-l-[5px] border-white" />
                <span className="absolute bottom-0 right-0 h-[52px] w-[52px] border-b-[5px] border-r-[5px] border-white" />
              </>
            )}
          </div>
        </div>

        <div className="relative z-10 flex flex-col items-center gap-2 px-5 pb-4 pt-1.5 text-center">
          {auto && hold !== null && (
            <div className="relative flex h-[60px] w-[60px] items-center justify-center rounded-full bg-field-accent">
              <span
                aria-hidden
                className="absolute inset-0 animate-f-ring rounded-full border-[3px] border-field-accent motion-reduce:animate-none"
              />
              <span className="text-f-25 font-bold text-field-accentText">{hold}</span>
            </div>
          )}
          <p
            role="status"
            aria-live="polite"
            className="text-f-21 font-bold text-white"
            style={{ textShadow: "0 1px 8px rgba(0,0,0,.8)" }}
          >
            {cameraError ? "Choose a photo" : auto ? "Hold steady…" : "Line it up and press"}
          </p>
          <p
            className="max-w-[290px] text-f-15 text-field-mutedDarkAlt"
            style={{ textShadow: "0 1px 8px rgba(0,0,0,.8)" }}
          >
            {cameraError
              ? cameraError
              : auto
                ? "Hold it still and it shoots itself — move to the next receipt and it goes again."
                : "Auto-capture is off. Use the big button when a receipt is crumpled, glossy or badly lit."}
          </p>
        </div>
      </div>

      {/* Burst history */}
      {shots.length > 0 && (
        <div className="flex items-center gap-2.5 overflow-x-auto border-t border-field-inkLine bg-field-camera px-4 py-3">
          {shots.map((s, i) => (
            <button
              key={s.id}
              onClick={onDone}
              className="relative h-[74px] w-[60px] shrink-0 overflow-hidden rounded-[12px] border-2 border-field-inkLine hover:border-field-accent"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.preview} alt="" className="h-full w-full object-cover" />
              <span className="absolute left-1 top-1 flex h-[22px] w-[22px] items-center justify-center rounded-full bg-field-accent text-f-13 font-bold text-field-accentText">
                {i + 1}
              </span>
              <span className="absolute bottom-1 left-1 text-f-12 font-semibold tabular-nums text-field-mutedDarkAlt">
                {s.status === "uploading"
                  ? "…"
                  : s.status === "queued"
                    ? "⤒"
                    : s.status === "failed"
                      ? "!"
                      : s.totalCents !== null
                        ? formatCents(s.totalCents)
                        : "—"}
              </span>
            </button>
          ))}
          <span className="shrink-0 text-f-14 text-field-mutedDark">
            {queued > 0 ? `${queued} waiting for signal` : "Totals read in the background"}
          </span>
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-col gap-3 border-t border-field-line bg-field-paper px-4 pb-[30px] pt-3.5">
        <input
          ref={fileRef}
          type="file"
          accept="image/*,application/pdf,.pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f, f.name);
            e.target.value = "";
          }}
        />
        <div className="flex items-center justify-between gap-3">
          <button
            onClick={() => setAuto((a) => !a)}
            aria-pressed={auto}
            className="flex h-[66px] w-[66px] flex-col items-center justify-center gap-1 rounded-[16px] border-[1.5px] border-field-line text-f-13 font-semibold"
          >
            <span aria-hidden className="h-6 w-6 rounded-full border-2 border-dashed border-field-muted" />
            {auto ? "Auto on" : "Auto off"}
          </button>

          <button
            onClick={() => (streaming ? void shoot() : fileRef.current?.click())}
            aria-label="Take a photo"
            className="flex h-[104px] w-[104px] items-center justify-center rounded-full bg-field-teal shadow-f-shutter transition active:scale-95 hover:bg-field-tealHover"
          >
            <span aria-hidden className="h-[74px] w-[74px] rounded-full border-4 border-white" />
          </button>

          <button
            onClick={onDone}
            className="flex h-[66px] w-[66px] flex-col items-center justify-center gap-1 rounded-[16px] border-[1.5px] border-field-line text-f-13 font-semibold"
          >
            <span aria-hidden className="h-6 w-6 rounded-[6px] border-2 border-field-muted" />
            Review
          </button>
        </div>

        <button
          onClick={onDone}
          className="h-[60px] rounded-[16px] bg-field-ink text-f-18 font-bold text-white disabled:opacity-50"
          disabled={shots.length === 0}
        >
          {shots.length === 0 ? "Nothing captured yet" : `Done — review ${readCount || shots.length}`}
        </button>

        <p className="text-center text-f-15 text-field-muted">
          {auto ? "Shutter still works whenever you want it." : "Tap Auto to let it shoot for you again."}
        </p>
      </div>
    </div>
  );
}
