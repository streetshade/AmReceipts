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
import { enqueue, flush, listPending, offlineQueueAvailable, isPermanentRejection } from "@/lib/offlineQueue";
import type { CaptureShot } from "@/lib/capture";

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

type Shot = CaptureShot;

/** A 140px-wide JPEG data URL from an image URL, or a rejection. */
function thumbnailFrom(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (!img.naturalWidth) return reject(new Error("empty image"));
      const canvas = document.createElement("canvas");
      const scale = 140 / img.naturalWidth;
      canvas.width = 140;
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("no 2d context"));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.6));
    };
    img.onerror = () => reject(new Error("could not decode"));
    img.src = url;
  });
}

export default function CapturePanel({
  sessionId,
  jobLabel,
  onDone,
  onItems,
  onReview,
  initialShots,
}: {
  sessionId: string;
  jobLabel: string;
  /** Leave the camera entirely - the back arrow, and the way out when nothing was shot. */
  onDone: () => void;
  onItems: () => void;
  /**
   * Hand the burst to the review screen.
   *
   * The shots go with it rather than the review screen re-deriving them: a
   * capture still in the offline queue has no receipt to be found by, and it
   * must still appear in a list headed "3 new receipts".
   */
  onReview: (shots: CaptureShot[]) => void;
  /**
   * The burst already taken, when the camera is re-entered from review.
   *
   * Without it, stepping back from review restarts the strip empty and the
   * technician has no way to see what they have already shot - which is the
   * one thing the strip is for.
   */
  initialShots?: CaptureShot[];
}) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [auto, setAuto] = useState(true);
  const [hold, setHold] = useState<number | null>(null);
  // Seeded once, on mount. The camera screen is unmounted while review is up -
  // so the phone is not left recording behind another screen - and this is what
  // carries the burst back in.
  const [shots, setShots] = useState<Shot[]>(() => initialShots ?? []);
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
            // The camera is released now rather than at unmount, so the phone
            // stops showing a recording indicator for a feed nobody can see.
            stream?.getTracks().forEach((t) => t.stop());
            stream = null;
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
  /**
   * Record a capture that went to the offline queue, and any it displaced.
   *
   * The evicted ones matter as much as the new one. The queue is bounded, and
   * when it overflows the oldest photographs are deleted - so their tiles have
   * to stop saying "sends when you get signal" about something that no longer
   * exists anywhere. An earlier version only counted them, and the review
   * screen went on listing them as still on their way.
   */
  const markQueued = useCallback((id: string, evicted: string[], settled: string) => {
    const lost = new Set(evicted);
    setShots((p) =>
      p.map((s) => {
        if (lost.has(s.id)) {
          return { ...s, status: "failed" as const, message: "Dropped to make room — take it again" };
        }
        if (s.id !== id) return s;
        return {
          ...s,
          status: "queued" as const,
          message:
            evicted.length > 0
              ? `Saved — but ${evicted.length} older photo${evicted.length === 1 ? "" : "s"} had to be dropped`
              : settled,
        };
      }),
    );
  }, []);

  /**
   * Send a capture that is ALREADY in `shots`.
   *
   * The tile is put on the strip by the caller, synchronously, before any of
   * the asynchronous work that produces the file. Minting the id and inserting
   * the tile here instead left a window - `canvas.toBlob` for a shot, an image
   * decode for a picked file - in which the photograph existed but the burst
   * did not know about it, and pressing Done during that window handed the
   * review screen a list with the newest receipt missing from it.
   */
  const upload = useCallback(
    async (id: string, blob: Blob, filename: string) => {
      const form = new FormData();
      form.append("image", blob, filename);
      // Minted by `beginShot` when the shutter fired, and reused by every retry
      // of this same capture. Without it the server's deduplication has nothing
      // to match on and a lost response still produces a second receipt.
      form.append("captureId", id);
      try {
        const res = await fetch(`/api/sessions/${sessionId}/receipts`, { method: "POST", body: form });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          // A server that is busy, rate-limiting or momentarily broken is not a
          // reason to lose a receipt. Only a permanent refusal is.
          if (!isPermanentRejection(res.status) && offlineQueueAvailable()) {
            try {
              const { evicted } = await enqueue({ id, sessionId, filename, blob, capturedAt: Date.now() });
              markQueued(id, evicted, "Saved — will try again");
              void refreshQueued();
              return;
            } catch {
              /* fall through */
            }
          }
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
            const { evicted } = await enqueue({ id, sessionId, filename, blob, capturedAt: Date.now() });
            markQueued(id, evicted, "Saved — sends when you get signal");
            void refreshQueued();
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
    [sessionId, router, markQueued],
  );

  /** Put a tile on the strip at once, so nothing can be captured invisibly. */
  const beginShot = useCallback((preview: string): string => {
    const id = crypto.randomUUID();
    setShots((prev) => [...prev, { id, preview, status: "uploading", totalCents: null, merchant: null }]);
    return id;
  }, []);

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
    // A small preview, made while the full frame is still on the canvas.
    const thumb = document.createElement("canvas");
    const scale = 140 / canvas.width;
    thumb.width = 140;
    thumb.height = Math.round(canvas.height * scale);
    thumb.getContext("2d")?.drawImage(canvas, 0, 0, thumb.width, thumb.height);
    const preview = thumb.toDataURL("image/jpeg", 0.6);

    // On the strip before the encode, not after it.
    const id = beginShot(preview);

    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.9));

    // The shutter is free again as soon as the frame exists. Holding it through
    // the upload meant every press during a slow connection was discarded -
    // exactly when a user presses hardest.
    armedAt.current = Date.now();
    busy.current = false;

    if (blob) {
      void upload(id, blob, `receipt-${Date.now()}.jpg`);
    } else {
      // toBlob returning null is rare but it is a LOST RECEIPT, and silence
      // here would mean the user believes they photographed something. The
      // tile is already on the strip; it is marked, not added.
      setShots((p) =>
        p.map((s) => (s.id === id ? { ...s, status: "failed", message: "Photo failed — take it again" } : s)),
      );
    }
  }, [beginShot, upload]);

  /**
   * A file chosen through the picker, rather than shot.
   *
   * The thumbnail is baked into a small data URL here, exactly as a camera shot
   * is, rather than being an object URL over the file. An object URL has a
   * lifetime, and this one outlives the screen that made it: the tile is handed
   * to the review screen, and revoking on unmount - which is when the camera
   * closes to show review - left every picked photo showing a broken image.
   * A few kilobytes of JPEG has no lifecycle at all.
   */
  const pick = useCallback(
    async (file: File) => {
      // On the strip first, with no thumbnail yet: decoding an image the user
      // chose takes long enough to press Done in, and a photograph that is not
      // on the strip is one the review screen never hears about.
      const id = beginShot("");
      // A PDF cannot be drawn into an <img>, so it gets no thumbnail; the
      // review screen falls back to the stored file for those.
      const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      if (!isPdf) {
        const url = URL.createObjectURL(file);
        try {
          const preview = await thumbnailFrom(url);
          setShots((p) => p.map((s) => (s.id === id ? { ...s, preview } : s)));
        } catch {
          // An image the browser cannot decode still uploads; it simply has no
          // preview, which is honest and is not a broken picture.
        } finally {
          // Released immediately: nothing holds it past this point.
          URL.revokeObjectURL(url);
        }
      }
      void upload(id, file, file.name);
    },
    [beginShot, upload],
  );

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
      // Two ticks showing "2", one showing "1". The previous formula spent
      // 550ms on 2 and 1100ms on 1, which read as a stall.
      setHold(Math.min(2, Math.max(1, Math.ceil(left / TICK_MS))));
    }, 120);
    return () => clearInterval(timer);
  }, [auto, streaming, shoot]);

  // Retry anything left over from a previous visit, and again whenever the
  // connection comes back. flush() serialises itself, so mount and an
  // immediate "online" event cannot upload the same photo twice.
  useEffect(() => {
    if (!offlineQueueAvailable()) return;
    let alive = true;

    const run = async () => {
      try {
        const { sent, rejected } = await flush((item, outcome) => {
          if (!alive) return;
          setShots((p) =>
            p.map((s) =>
              s.id === item.id
                ? outcome === "sent"
                  ? { ...s, status: "read", message: undefined }
                  : { ...s, status: "failed", message: "The server refused this photo" }
                : s,
            ),
          );
        });
        if (!alive) return;
        if (sent > 0 || rejected > 0) router.refresh();
        const remaining = await listPending(sessionId);
        if (alive) setQueued(remaining.length);
      } catch {
        // A queue that cannot be read must not take the screen down with it.
      }
    };

    void run();
    const onOnline = () => void run();
    window.addEventListener("online", onOnline);
    return () => {
      alive = false;
      window.removeEventListener("online", onOnline);
    };
  }, [router, sessionId]);

  const refreshQueued = useCallback(async () => {
    try {
      setQueued((await listPending(sessionId)).length);
    } catch {
      /* the count is informational */
    }
  }, [sessionId]);

  const readCount = shots.filter((s) => s.status === "read").length;

  // Review is where the burst is confirmed, so the three ways of finishing a
  // burst - the Review button, `Done`, and tapping a shot - all land there.
  // Only the back arrow leaves the camera without reviewing.
  const review = useCallback(() => onReview(shots), [onReview, shots]);

  return (
    <div className="flex min-h-[100dvh] flex-col bg-field-ground font-field text-field-ink">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-field-line bg-field-paper px-4 pb-3 pt-[calc(env(safe-area-inset-top)+14px)]">
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

        {/*
          The frame sits at the bounds of the camera, not in a fixed 258x290 box
          floating inside it.

          The design was authored at a 390px frame, where a fixed box happened
          to fill most of the width. On a real phone it read as a small window
          adrift in the picture, telling the user to line a receipt up inside
          borders that meant nothing.

          It outlines what is VISIBLE, which is not quite the same as what is
          saved: the feed is drawn `object-cover`, so a stream whose shape does
          not match this area is cropped on screen, while `shoot()` writes the
          whole frame. The photograph is therefore a superset of what is framed
          here - nothing a technician lines up can be lost, which is the
          direction that matters.

          Absolutely positioned over the whole camera area, so the caption and
          the feed label float over it rather than squeezing it into a middle
          row.
        */}
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-2 rounded-[12px] ${
            auto ? "overflow-hidden border-[5px] border-field-accent" : ""
          }`}
        >
          {auto ? (
            <div
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

        {/* Spacer for the row the frame used to occupy, so the caption stays
            at the bottom of the camera rather than under the feed label. */}
        <div className="relative z-10 flex-1" />

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
              onClick={review}
              className="relative h-[74px] w-[60px] shrink-0 overflow-hidden rounded-[12px] border-2 border-field-inkLine hover:border-field-accent"
            >
              {s.preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={s.preview} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center bg-field-inkRaised text-f-13 font-semibold text-field-mutedDarkAlt">
                  PDF
                </span>
              )}
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
            if (f) void pick(f);
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
            onClick={review}
            disabled={shots.length === 0}
            className="flex h-[66px] w-[66px] flex-col items-center justify-center gap-1 rounded-[16px] border-[1.5px] border-field-line text-f-13 font-semibold disabled:opacity-40"
          >
            <span aria-hidden className="h-6 w-6 rounded-[6px] border-2 border-field-muted" />
            Review
          </button>
        </div>

        <button
          onClick={shots.length === 0 ? onDone : review}
          className="h-[60px] rounded-[16px] bg-field-ink text-f-18 font-bold text-white"
        >
          {shots.length === 0 ? "Nothing captured yet — go back" : `Done — review ${readCount || shots.length}`}
        </button>

        <p className="text-center text-f-15 text-field-muted">
          {auto ? "Shutter still works whenever you want it." : "Tap Auto to let it shoot for you again."}
        </p>
      </div>
    </div>
  );
}
