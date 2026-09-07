"use client";

// Home — start a capture in one tap, and see where the day stands.
//
// The order on the screen is the order of the day: which job you're on, then
// the camera, then what it has added up to, then what is still hanging over
// you. Nothing above the camera button is a decision the technician has to
// make before photographing a receipt.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatCents } from "@/lib/money";
import { flush, listPending, offlineQueueAvailable } from "@/lib/offlineQueue";
import type { HomeSummary } from "@/lib/homeSummary";
import OnSiteBanner, { type JobOption } from "./OnSiteBanner";
import VisitCardLink from "./VisitCardLink";

export default function HomeScreen({
  summary,
  recentJobs,
}: {
  summary: HomeSummary;
  recentJobs: JobOption[];
}) {
  const router = useRouter();
  const [pendingSync, setPendingSync] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The job the banner is confident about, lifted up so the big button books to
  // the same place `Log here` would. Null means it has not matched one.
  const [siteJobId, setSiteJobId] = useState<string | null>(null);
  const alive = useRef(true);
  /**
   * The double-tap guard.
   *
   * `busy` is state, and state is not readable until React has re-rendered, so
   * two taps a few milliseconds apart both see `busy === false` and both post.
   * A ref changes on the spot. `busy` stays, but only to grey the buttons.
   */
  const starting = useRef(false);
  /**
   * Releases the guard if the navigation never happens.
   *
   * `router.push` returns nothing and can be intercepted or simply fail, and
   * the guard is deliberately not released on the success path. Without this
   * timer a push that quietly went nowhere left every button on the screen
   * dead until the user reloaded.
   */
  const stuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (stuckTimer.current) clearTimeout(stuckTimer.current);
    };
  }, []);

  // The "2 to sync" chip. There is no change event on IndexedDB, so this is
  // read at the moments the count can plausibly have moved - arriving on the
  // screen, coming back to the tab, regaining signal - rather than on a timer
  // that spins a phone's radio all day.
  const refreshPending = useCallback(async () => {
    if (!offlineQueueAvailable()) return;
    try {
      const rows = await listPending();
      if (alive.current) setPendingSync(rows.length);
    } catch {
      // A browser that refuses IndexedDB (private mode) simply shows no chip.
    }
  }, []);

  const trySync = useCallback(async () => {
    if (!offlineQueueAvailable()) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      await refreshPending();
      return;
    }
    try {
      const result = await flush();
      if (!alive.current) return;
      setPendingSync(result.remaining);
      // Anything that landed changes today's total, so the server figures are
      // now stale. Refreshed only when something actually moved.
      if (result.sent > 0) router.refresh();
    } catch {
      await refreshPending();
    }
  }, [refreshPending, router]);

  useEffect(() => {
    void trySync();
    const onOnline = () => void trySync();
    const onVisible = () => {
      if (document.visibilityState === "visible") void trySync();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [trySync]);

  /**
   * Open a visit and go straight to the camera.
   *
   * `jobId` null means the tech chose to start without a job; the visit is
   * created unassigned and the Job visit screen can attach one later. Blocking
   * capture on an assignment would be exactly the trade the redesign rejects -
   * the receipt is on paper and about to be thrown away, the job number is not.
   */
  const start = useCallback(
    async (jobId: string | null) => {
      if (starting.current) return;
      starting.current = true;
      setBusy(true);
      setErr(null);
      try {
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(jobId ? { jobId } : { unassigned: true }),
        });
        if (!res.ok) {
          starting.current = false;
          // Guarded: the request can outlive the screen, and a rejection
          // arriving after the user has moved on has nobody to tell.
          if (alive.current) {
            setErr("Couldn't open a visit. Try again in a moment.");
            setBusy(false);
          }
          return;
        }
        const { id } = (await res.json()) as { id: string };
        // `capture=1` opens the camera on arrival, so `Log here` is one tap to
        // a viewfinder rather than one tap to another screen with a button.
        // The guard is NOT released here: the navigation is under way, and
        // releasing it would let a second tap open a second visit. The timer
        // below is the way out if the navigation never lands.
        stuckTimer.current = setTimeout(() => {
          starting.current = false;
          if (alive.current) setBusy(false);
        }, 12_000);
        router.push(`/sessions/${id}?capture=1`);
      } catch {
        starting.current = false;
        if (alive.current) {
          setErr("No connection. Open a visit you already have below.");
          setBusy(false);
        }
      }
    },
    [router],
  );

  /**
   * The big button.
   *
   * It books to the job the banner matched, and otherwise to a visit with no
   * job on it. What it must NOT do is resume whichever visit happens to be
   * open: the most recently touched unapproved visit is often yesterday's, at
   * yesterday's job, and a day of receipts would land there without anyone
   * being shown a job number at any point. The server resumes today's visit for
   * the job - or today's unassigned one - so tapping this repeatedly still
   * collects into a single visit.
   */
  const scan = useCallback(() => {
    void start(siteJobId);
  }, [siteJobId, start]);

  return (
    <div className="flex flex-1 flex-col bg-field-ground font-field text-field-ink">
      <header className="flex items-start justify-between gap-3 border-b border-field-line bg-field-paper px-5 pb-4 pt-[52px]">
        <div className="min-w-0">
          <p className="text-f-14 font-semibold uppercase tracking-[.08em] text-field-muted">{summary.weekday}</p>
          <h1 className="truncate text-f-25 font-bold">{summary.greeting}, {summary.firstName}</h1>
        </div>
        {pendingSync > 0 && (
          <span className="mt-1 flex shrink-0 items-center gap-2 rounded-full border border-field-warnLine bg-field-warnFill px-3 py-1.5 text-f-14 font-semibold text-field-warnText">
            <span aria-hidden className="block h-[9px] w-[9px] rounded-full bg-field-warnDot" />
            {pendingSync} to sync
          </span>
        )}
      </header>

      <div className="flex flex-col gap-4 px-5 pb-6 pt-4">
        <OnSiteBanner recentJobs={recentJobs} busy={busy} onStart={start} onMatch={setSiteJobId} />

        {err && (
          <p role="alert" className="rounded-[14px] border border-field-dangerLine bg-field-dangerFill px-4 py-3 text-f-16 text-field-ink">
            {err}
          </p>
        )}

        <button
          onClick={scan}
          disabled={busy}
          className="flex h-[112px] w-full items-center gap-4 rounded-[20px] bg-field-teal px-5 text-left shadow-f-primary transition hover:bg-field-tealHover disabled:opacity-60"
        >
          <span aria-hidden className="flex h-[62px] w-[62px] shrink-0 items-center justify-center rounded-full ring-4 ring-white">
            <span className="block h-[26px] w-[34px] rounded-[4px] border-[3px] border-white" />
          </span>
          <span className="min-w-0">
            <span className="block text-f-24 font-bold text-white">Scan a receipt</span>
            <span className="block text-f-16 text-[#BFE8E2]">Point at it — it shoots itself</span>
          </span>
        </button>

        <div className="flex gap-3">
          <StatCard
            label="Today"
            value={formatCents(summary.today.totalCents)}
            meta={`${summary.today.receiptCount} receipt${summary.today.receiptCount === 1 ? "" : "s"}`}
          />
          <StatCard
            label="This week"
            value={formatCents(summary.week.totalCents)}
            meta={`${summary.week.visitCount} job visit${summary.week.visitCount === 1 ? "" : "s"}`}
          />
        </div>

        <section>
          <div className="flex items-center justify-between">
            <h2 className="text-f-14 font-semibold uppercase tracking-[.08em] text-field-muted">Still open</h2>
            {summary.openVisitCount > 0 && (
              <Link href="/dashboard/visits" className="text-f-16 font-semibold text-field-teal">
                {summary.openVisitCount > summary.openVisits.length ? `See all ${summary.openVisitCount}` : "See all"}
              </Link>
            )}
          </div>
          <div className="mt-2 space-y-2">
            {summary.openVisits.length === 0 ? (
              <p className="rounded-[16px] border border-field-line bg-field-paper p-4 text-f-17 text-field-muted">
                Nothing open. Scan a receipt and a visit starts itself.
              </p>
            ) : (
              summary.openVisits.map((v) => <VisitCardLink key={v.id} visit={v} />)
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function StatCard({ label, value, meta }: { label: string; value: string; meta: string }) {
  return (
    <div className="flex-1 rounded-[16px] border border-field-line bg-field-paper p-4">
      <p className="text-f-13 font-semibold uppercase tracking-[.08em] text-field-muted">{label}</p>
      <p className="mt-1 text-f-27 font-bold tabular-nums">{value}</p>
      <p className="text-f-15 text-field-muted">{meta}</p>
    </div>
  );
}
