// The figures behind the field Home screen, and the cards behind Visits.
//
// The two stat cards are drawn from one set of receipts because they are read
// as one sentence - "This week $646.74 / 5 job visits" - and a week total drawn
// from receipts beside a visit count drawn from sessions would disagree the
// moment someone opened a visit and bought nothing.

import { prisma } from "./db";
import {
  appTimeZone,
  calendarDayRange,
  calendarWeekRange,
  dayRange,
  localParts,
  weekRange,
  weekdayName,
} from "./timeRange";

/**
 * The four states a visit can be in, in the words the design uses.
 *
 * The repository stores this as two columns - `status` (open/assigned/closed)
 * and `approvalStatus` (draft/submitted/approved/rejected) - which between them
 * can express states nobody means. Approval is the one a technician cares
 * about, so it is the one shown.
 */
export type VisitStatus = "collecting" | "waiting" | "approved" | "sent-back";

export const VISIT_STATUS_LABEL: Record<VisitStatus, string> = {
  collecting: "Collecting",
  waiting: "Waiting on approval",
  approved: "Approved",
  "sent-back": "Sent back — fix the total",
};

export function visitStatus(session: { approvalStatus: string }): VisitStatus {
  switch (session.approvalStatus) {
    case "submitted":
      return "waiting";
    case "approved":
      return "approved";
    case "rejected":
      return "sent-back";
    default:
      return "collecting";
  }
}

export interface VisitCard {
  id: string;
  title: string;
  /** "Today · 4 receipts · 7 items" */
  meta: string;
  status: VisitStatus;
  statusLabel: string;
  totalCents: number;
  /**
   * Started today, in the app's time zone.
   *
   * Home's big button resumes a visit rather than opening a new one, and this
   * is what stops it resuming yesterday's - which would book today's receipts
   * against yesterday's job.
   */
  startedToday: boolean;
}

export interface HomeSummary {
  /** "Wednesday" */
  weekday: string;
  /** "Morning" / "Afternoon" / "Evening", in the app's time zone. */
  greeting: string;
  /** First name only - "Morning, Dan". */
  firstName: string;
  today: { totalCents: number; receiptCount: number };
  /**
   * `visitCount` is the number of visits that COLLECTED A RECEIPT this week,
   * not the number opened this week.
   *
   * The two figures are read as one sentence - "$646.74 · 5 job visits" - so
   * they are drawn from the same set of receipts. Counting visits opened
   * instead would put a visit with nothing on it into a total it contributed
   * nothing to.
   *
   * A receipt whose total has not been read yet still counts its visit. It is
   * a receipt; the money was spent, and dropping the visit until the figure
   * appears would make the count jump about as photographs are processed.
   */
  week: { totalCents: number; visitCount: number };
}

/** The half of the day the greeting should reflect. */
export function greetingFor(hour: number): string {
  if (hour < 12) return "Morning";
  if (hour < 18) return "Afternoon";
  return "Evening";
}

/** "Today", "Yesterday", or a short date. Exported so it can be checked. */
export function relativeDay(date: Date, now: Date, timeZone: string): string {
  const today = dayRange(now, timeZone);
  if (date >= today.start && date < today.end) return "Today";
  // Yesterday is the calendar day before, not the 24 hours before: the day
  // either side of a clock change is 23 or 25 hours long, and subtracting a
  // fixed 86,400,000 either loses an hour of it or reaches into the day before.
  // Noon of the previous local day is safely inside it whatever the offset did.
  const yesterday = dayRange(new Date(today.start.getTime() - 12 * 3600_000), timeZone);
  if (date >= yesterday.start && date < yesterday.end) return "Yesterday";
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short" }).format(date);
}

export function visitTitle(s: {
  name: string;
  job: { number: string; name: string | null } | null;
}): string {
  if (s.job) return s.job.name ? `${s.job.name} · ${s.job.number}` : s.job.number;
  return s.name;
}

/** The rows Home and Visits both draw. Shared so the two cannot drift apart. */
type VisitRow = {
  id: string;
  name: string;
  approvalStatus: string;
  createdAt: Date;
  updatedAt: Date;
  job: { number: string; name: string | null } | null;
  receipts: { total: number | null }[];
  scannedItems: { quantity: number }[];
  _count: { receipts: number };
};

function toVisitCard(s: VisitRow, now: Date, timeZone: string): VisitCard {
  const status = visitStatus(s);
  // Quantities, not rows. "7 items" means seven things bought; six of one
  // fitting scanned once is six items, and counting the row said one - which
  // also disagreed with the number the visit screen itself shows.
  const items = s.scannedItems.reduce((acc, i) => acc + i.quantity, 0);
  const today = dayRange(now, timeZone);
  const meta = [
    relativeDay(s.updatedAt, now, timeZone),
    `${s._count.receipts} receipt${s._count.receipts === 1 ? "" : "s"}`,
    ...(items > 0 ? [`${items} item${items === 1 ? "" : "s"}`] : []),
  ].join(" · ");
  return {
    id: s.id,
    title: visitTitle(s),
    meta,
    status,
    statusLabel: VISIT_STATUS_LABEL[status],
    totalCents: s.receipts.reduce((acc, r) => acc + (r.total ?? 0), 0),
    startedToday: s.createdAt >= today.start && s.createdAt < today.end,
  };
}

const VISIT_INCLUDE = {
  job: { select: { number: true, name: true } },
  receipts: { select: { total: true } },
  scannedItems: { select: { quantity: true } },
  _count: { select: { receipts: true } },
} as const;

/**
 * Every visit, newest activity first, for the Visits screen.
 *
 * Capped rather than unbounded: a phone list nobody scrolls past the first
 * screen of does not need a year of history, and an unpaged findMany over a
 * long-serving technician's account is a slow query waiting to happen.
 */
export const VISIT_LIST_LIMIT = 100;

export async function loadVisitCards(userId: string, now = new Date()): Promise<VisitCard[]> {
  const tz = appTimeZone();
  const rows = await prisma.expenseSession.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: VISIT_LIST_LIMIT,
    include: VISIT_INCLUDE,
  });
  return rows.map((s) => toVisitCard(s, now, tz));
}

export async function loadHomeSummary(user: { id: string; name: string }, now = new Date()): Promise<HomeSummary> {
  const tz = appTimeZone();
  // Two pairs of bounds for the same two periods. `createdAt` is an instant and
  // is compared against zoned instants; `purchaseDate` is a DATE off a piece of
  // paper, and is compared against the UTC calendar day it falls on. Using one
  // pair for both put every dated receipt on the wrong side of the boundary by
  // the zone's offset. See `calendarDayRange` for why.
  const week = weekRange(now, tz);
  const day = dayRange(now, tz);
  const calWeek = calendarWeekRange(now, tz);
  const calDay = calendarDayRange(now, tz);

  // One query for both cards. Today is inside this week by construction, so
  // the day figures are a filter over the same rows rather than a second trip.
  const receipts = await prisma.receipt.findMany({
    where: {
      session: { userId: user.id },
      OR: [
        { purchaseDate: { gte: calWeek.start, lt: calWeek.end } },
        // A receipt with no date read off it falls back to when it was taken.
        { AND: [{ purchaseDate: null }, { createdAt: { gte: week.start, lt: week.end } }] },
      ],
    },
    select: { total: true, sessionId: true, purchaseDate: true, createdAt: true },
  });

  let todayTotal = 0;
  let todayCount = 0;
  let weekTotal = 0;
  const weekSessions = new Set<string>();
  for (const r of receipts) {
    const isToday = r.purchaseDate
      ? r.purchaseDate >= calDay.start && r.purchaseDate < calDay.end
      : r.createdAt >= day.start && r.createdAt < day.end;
    weekTotal += r.total ?? 0;
    weekSessions.add(r.sessionId);
    if (isToday) {
      todayTotal += r.total ?? 0;
      todayCount++;
    }
  }

  // No list of open visits here any more. Home showed one and it was a second
  // copy of the Visits tab, one tap away - and it was what pushed the day's
  // figures below the fold on a real phone, on a screen whose whole job is to
  // be answered without scrolling.

  return {
    weekday: weekdayName(now, tz),
    greeting: greetingFor(localParts(now, tz).hour),
    // Split on whitespace rather than assuming a first name is one word before
    // a space - it is, but an empty name would otherwise render "Morning, ".
    firstName: user.name.trim().split(/\s+/)[0] || user.name,
    today: { totalCents: todayTotal, receiptCount: todayCount },
    week: { totalCents: weekTotal, visitCount: weekSessions.size },
  };
}
