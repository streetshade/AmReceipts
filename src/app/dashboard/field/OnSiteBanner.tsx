"use client";

// "You're on site at Riverside · 4821."
//
// This banner is the design's answer to the worst part of the old app: a
// technician in a vehicle, with gloves on, typing a job number from memory. The
// job comes from where the phone is, and the only thing left to do is agree.
//
// The whole difficulty is that a location fix is not a fact, it is a claim with
// an error bar - and this banner reads as a fact. So it only ever asserts a job
// when the fix is precise enough to distinguish that job from every other one
// nearby; the rest of the time it says what it does not know and offers a
// picker. `Other job` is always there either way.

import { useCallback, useEffect, useRef, useState } from "react";

export interface JobOption {
  id: string;
  number: string;
  name: string | null;
  address: string | null;
  label: string;
  distanceMetres?: number;
}

type MatchReason = "matched" | "ambiguous" | "no-site-near" | "fix-too-vague" | "no-sites-located";

type State =
  | { kind: "idle" }          // permission not yet granted; wait to be asked
  | { kind: "locating" }
  | { kind: "matched"; job: JobOption }
  | { kind: "choose"; jobs: JobOption[]; note: string }
  | { kind: "unavailable"; note: string };

/** Copy for each way the match can come back empty. */
const NO_MATCH_NOTE: Record<Exclude<MatchReason, "matched" | "ambiguous">, string> = {
  "no-site-near": "No job site near here.",
  "fix-too-vague": "Your location isn't precise enough to tell the sites apart.",
  "no-sites-located": "None of your jobs have a location saved yet.",
};

function distanceLabel(metres?: number): string | null {
  if (typeof metres !== "number" || !Number.isFinite(metres)) return null;
  return metres < 1000 ? `${metres} m away` : `${(metres / 1000).toFixed(1)} km away`;
}

export default function OnSiteBanner({
  recentJobs,
  busy,
  onStart,
  onMatch,
}: {
  /** The picker's contents when location cannot answer. Never a bare text field. */
  recentJobs: JobOption[];
  /** A visit is being created; the buttons are greyed while it is. */
  busy: boolean;
  onStart: (jobId: string | null) => void;
  /**
   * The job this banner is confident about, or null.
   *
   * Reported upward so Home's "Scan a receipt" books to the same place `Log
   * here` would, rather than to whichever visit happened to be open last.
   */
  onMatch?: (jobId: string | null) => void;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [expanded, setExpanded] = useState(false);
  // Survives unmount mid-request: a fix can take fifteen seconds, and by then
  // the user may have navigated away.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Held in a ref so `locate` does not need the callback in its dependency
  // list: a parent that passes a fresh arrow function every render would
  // otherwise rebuild `locate` and re-trigger the permission effect on every
  // render, asking for a fix in a loop.
  const report = useRef(onMatch);
  useEffect(() => {
    report.current = onMatch;
  }, [onMatch]);

  const locate = useCallback(() => {
    report.current?.(null);
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setState({ kind: "unavailable", note: "This phone won't share its location." });
      return;
    }
    setState({ kind: "locating" });
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        if (!alive.current) return;
        const params = new URLSearchParams({
          lat: String(pos.coords.latitude),
          lng: String(pos.coords.longitude),
        });
        // Omitted rather than sent as null when the browser withholds it, so
        // the server applies its own worst-case rule instead of parsing a
        // placeholder as a number.
        if (typeof pos.coords.accuracy === "number" && Number.isFinite(pos.coords.accuracy)) {
          params.set("accuracy", String(pos.coords.accuracy));
        }
        try {
          const res = await fetch(`/api/jobs/nearby?${params.toString()}`);
          if (!alive.current) return;
          if (!res.ok) {
            setState({ kind: "unavailable", note: "Couldn't check your job sites just now." });
            return;
          }
          const data = (await res.json()) as {
            reason: MatchReason;
            match: JobOption | null;
            candidates: JobOption[];
          };
          if (!alive.current) return;
          if (data.reason === "matched" && data.match) {
            setState({ kind: "matched", job: data.match });
            report.current?.(data.match.id);
          } else if (data.reason === "ambiguous" && data.candidates.length > 0) {
            setState({ kind: "choose", jobs: data.candidates, note: "You're between two sites — which one?" });
          } else {
            const note = NO_MATCH_NOTE[data.reason as keyof typeof NO_MATCH_NOTE] ?? "Couldn't work out which job you're on.";
            setState({ kind: "unavailable", note });
          }
        } catch {
          if (!alive.current) return;
          // Offline is the expected case on site, not an error worth alarming
          // anyone about. The picker below still works.
          setState({ kind: "unavailable", note: "No signal — pick the job and carry on." });
        }
      },
      (err) => {
        if (!alive.current) return;
        setState({
          kind: "unavailable",
          note:
            err.code === err.PERMISSION_DENIED
              ? "Location is turned off for this app."
              : "Couldn't get a location fix.",
        });
      },
      // High accuracy because the decision is which of two nearby sites this
      // is, and `maximumAge: 0` because a cached fix has no place in it: a
      // minute-old position is several hundred metres stale in a moving van,
      // and the server has no way to tell a stale precise fix from a fresh one.
      // Fifteen seconds is the longest worth waiting before showing the picker.
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  }, []);

  // Ask only if the user has already agreed to be located. A permission prompt
  // thrown up the instant the app opens gets denied on reflex, and denial is
  // sticky.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (typeof navigator === "undefined" || !navigator.geolocation) {
        setState({ kind: "unavailable", note: "This phone won't share its location." });
        return;
      }
      try {
        const status = await navigator.permissions.query({ name: "geolocation" as PermissionName });
        if (cancelled) return;
        if (status.state === "granted") locate();
        else if (status.state === "denied") {
          report.current?.(null);
          setState({ kind: "unavailable", note: "Location is turned off for this app." });
        }
        // "prompt" stays idle: the button below asks, on a tap.
      } catch {
        // Safari lacked the geolocation permission name for years. Falling back
        // to idle shows the button, which is the same outcome as "prompt".
        if (!cancelled) setState({ kind: "idle" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [locate]);

  const shell = "rounded-[18px] bg-field-ink p-[18px] font-field";

  if (state.kind === "matched") {
    const job = state.job;
    return (
      <section className={shell} aria-live="polite">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="mt-1 block h-3 w-3 shrink-0 rounded-full bg-field-accent shadow-f-livedot"
          />
          <div className="min-w-0">
            <p className="text-f-14 text-field-mutedDark">You&rsquo;re on site at</p>
            <p className="truncate text-f-22 font-bold text-white">{job.label}</p>
            <p className="text-f-16 text-field-mutedDark">
              {job.address ? `${job.address} — ` : ""}matched from your location
            </p>
          </div>
        </div>
        <div className="mt-4 flex gap-3">
          <button
            onClick={() => onStart(job.id)}
            disabled={busy}
            className="h-14 flex-1 rounded-[14px] bg-field-accent text-f-18 font-bold text-field-accentText transition hover:bg-field-accentHover disabled:opacity-60"
          >
            {busy ? "Opening…" : "Log here"}
          </button>
          <button
            onClick={() => setExpanded((e) => !e)}
            disabled={busy}
            className="h-14 rounded-[14px] border-[1.5px] border-field-inkLine px-5 text-f-17 font-semibold text-field-accent transition hover:border-field-accent disabled:opacity-60"
          >
            Other job
          </button>
        </div>
        {expanded && <Picker jobs={recentJobs} busy={busy} onStart={onStart} exclude={job.id} />}
      </section>
    );
  }

  if (state.kind === "locating") {
    return (
      <section className={shell} aria-live="polite">
        <div className="flex items-center gap-3">
          <span aria-hidden className="block h-3 w-3 shrink-0 animate-pulse rounded-full bg-field-accent" />
          <p className="text-f-19 font-bold text-white">Finding the job you&rsquo;re on…</p>
        </div>
        <p className="mt-1 text-f-16 text-field-mutedDark">Takes a moment outdoors.</p>
      </section>
    );
  }

  if (state.kind === "choose") {
    return (
      <section className={shell} aria-live="polite">
        <p className="text-f-19 font-bold text-white">{state.note}</p>
        <Picker jobs={state.jobs} busy={busy} onStart={onStart} />
      </section>
    );
  }

  // idle and unavailable share a shape: a line saying where we stand, a way to
  // try location, and the picker. The technician is never stuck.
  const note = state.kind === "idle" ? "Let the app fill in the job when you arrive on site." : state.note;
  return (
    <section className={shell} aria-live="polite">
      <p className="text-f-19 font-bold text-white">
        {state.kind === "idle" ? "Which job are you on?" : "Couldn't tell which job you're on"}
      </p>
      <p className="mt-1 text-f-16 text-field-mutedDark">{note}</p>
      {state.kind === "idle" && (
        <button
          onClick={locate}
          className="mt-4 h-14 w-full rounded-[14px] bg-field-accent text-f-18 font-bold text-field-accentText transition hover:bg-field-accentHover"
        >
          Use my location
        </button>
      )}
      <Picker jobs={recentJobs} busy={busy} onStart={onStart} />
    </section>
  );
}

/** The manual path. A list of the jobs they actually work on, not a text box. */
function Picker({
  jobs,
  busy,
  onStart,
  exclude,
}: {
  jobs: JobOption[];
  busy: boolean;
  onStart: (jobId: string | null) => void;
  exclude?: string;
}) {
  const shown = jobs.filter((j) => j.id !== exclude);
  return (
    <div className="mt-4 space-y-2 border-t border-field-inkLine pt-4">
      {shown.length === 0 ? (
        <p className="text-f-16 text-field-mutedDark">No jobs on this account yet.</p>
      ) : (
        shown.map((job) => {
          const distance = distanceLabel(job.distanceMetres);
          return (
            <button
              key={job.id}
              onClick={() => onStart(job.id)}
              disabled={busy}
              className="flex min-h-[56px] w-full items-center justify-between gap-3 rounded-[14px] border-[1.5px] border-field-inkLine px-4 py-2 text-left transition hover:border-field-accent disabled:opacity-60"
            >
              <span className="min-w-0">
                <span className="block truncate text-f-17 font-semibold text-white">{job.label}</span>
                {(distance || job.address) && (
                  <span className="block truncate text-f-15 text-field-mutedDark">{distance ?? job.address}</span>
                )}
              </span>
              <span aria-hidden className="shrink-0 text-f-17 text-field-accent">
                ›
              </span>
            </button>
          );
        })
      )}
      <button
        onClick={() => onStart(null)}
        disabled={busy}
        className="min-h-[56px] w-full rounded-[14px] border-[1.5px] border-dashed border-field-dashed px-4 text-f-17 font-semibold text-field-mutedDarkAlt transition hover:border-field-accent hover:text-field-accent disabled:opacity-60"
      >
        Start without a job — sort it out later
      </button>
    </div>
  );
}
