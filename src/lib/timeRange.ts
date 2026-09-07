// Day and week boundaries in a named time zone.
//
// "Today $202.29 / 4 receipts" is only true if today ends where the user's day
// ends. A server running in UTC puts the boundary at 7pm in Vancouver, so an
// evening receipt lands on tomorrow's card and the technician sees a figure
// they cannot reconcile with the paper in their pocket.
//
// No date library: the two operations needed are a day and a week, and Intl
// already carries the zone database. The trick throughout is that
// `Intl.DateTimeFormat` can tell us what a UTC instant READS as in a zone, and
// everything else follows from inverting that.

/**
 * The zone the app reports in.
 *
 * A deployment serving one crew sets APP_TIME_ZONE; otherwise the host's zone
 * is used, which is right on a developer's machine and is at least a stated
 * default in a container. Per-user zones would be better and are not modelled -
 * the technician this is built for crosses one border, not eight.
 */
export function appTimeZone(): string {
  const configured = process.env.APP_TIME_ZONE?.trim();
  if (configured) return configured;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday, as `Date.prototype.getDay` numbers them. */
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Validates a zone name once, falling back rather than throwing at request time. */
export function safeTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** What a UTC instant reads as on the wall clock in `timeZone`. */
export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  }).formatToParts(instant);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const weekdayName = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    // `hour12: false` yields "24" for midnight in some engines rather than
    // "00". Left unhandled it makes midnight look like the end of the day.
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: Math.max(0, WEEKDAYS.indexOf(weekdayName)),
  };
}

/** How far ahead of UTC `timeZone` is at `instant`, in milliseconds. */
function offsetMs(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Truncated to whole seconds on both sides so the sub-second remainder does
  // not leak into the offset.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant at which a given local calendar date begins.
 *
 * Solved by iteration because the offset itself depends on the answer: the
 * first guess uses the offset in force now, the second uses the offset in force
 * at the guessed midnight, which is what makes the day after a DST change come
 * out right. Where local midnight does not exist at all - a spring-forward at
 * 00:00, as parts of South America have had - this settles on the first instant
 * of the day that does exist, which is the useful answer anyway.
 */
function startOfLocalDay(year: number, month: number, day: number, timeZone: string, near: Date): Date {
  const wall = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = wall - offsetMs(near, timeZone);
  for (let i = 0; i < 2; i++) {
    guess = wall - offsetMs(new Date(guess), timeZone);
  }
  return new Date(guess);
}

export interface Range {
  /** Inclusive. */
  start: Date;
  /** Exclusive - the next boundary, not the last millisecond before it. */
  end: Date;
}

/** Local midnight to local midnight, around `now`. */
export function dayRange(now: Date, timeZone: string): Range {
  const tz = safeTimeZone(timeZone);
  const p = localParts(now, tz);
  const start = startOfLocalDay(p.year, p.month, p.day, tz, now);
  // Built from the calendar date rather than by adding 24 hours, so a day with
  // a DST change is 23 or 25 hours long as it should be.
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const end = startOfLocalDay(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    tz,
    new Date(start.getTime() + 36 * 3600_000),
  );
  return { start, end };
}

/**
 * The local week containing `now`, Monday to Monday.
 *
 * Monday because that is how a working week is counted here, and because a
 * Sunday-start week puts half a weekend's travel in the previous one.
 */
export function weekRange(now: Date, timeZone: string): Range {
  const tz = safeTimeZone(timeZone);
  const p = localParts(now, tz);
  // getDay numbering has Sunday at 0; Monday-start needs Sunday to be 6.
  const backToMonday = (p.weekday + 6) % 7;
  const mondayUtc = new Date(Date.UTC(p.year, p.month - 1, p.day - backToMonday));
  const start = startOfLocalDay(
    mondayUtc.getUTCFullYear(),
    mondayUtc.getUTCMonth() + 1,
    mondayUtc.getUTCDate(),
    tz,
    now,
  );
  const nextMondayUtc = new Date(Date.UTC(p.year, p.month - 1, p.day - backToMonday + 7));
  const end = startOfLocalDay(
    nextMondayUtc.getUTCFullYear(),
    nextMondayUtc.getUTCMonth() + 1,
    nextMondayUtc.getUTCDate(),
    tz,
    new Date(start.getTime() + 7 * 24 * 3600_000),
  );
  return { start, end };
}

/**
 * The same local day and week, expressed as UTC-midnight bounds.
 *
 * This exists because a receipt's `purchaseDate` is a DATE, not an instant. The
 * date field on the classic editor and the OCR date reader both write the
 * calendar date off the paper at UTC midnight, because a receipt does not carry
 * a time zone. (The offline stub OCR provider writes a full timestamp instead,
 * so the value is read as "whatever UTC calendar day it falls on" rather than
 * being assumed to be exactly midnight.)
 *
 * Compared against zoned instants, that convention is off by the offset: a
 * receipt dated 2 September reads as 1 September at 5pm in Vancouver, drops out
 * of the "Today" card, and reappears the next morning. So date-only values are
 * compared date to date, and only `createdAt` - which IS an instant - is
 * compared against the zoned bounds above.
 */
export function calendarDayRange(now: Date, timeZone: string): Range {
  const p = localParts(now, safeTimeZone(timeZone));
  return {
    start: new Date(Date.UTC(p.year, p.month - 1, p.day)),
    end: new Date(Date.UTC(p.year, p.month - 1, p.day + 1)),
  };
}

/** The local Monday-to-Monday week, as UTC-midnight bounds. See above. */
export function calendarWeekRange(now: Date, timeZone: string): Range {
  const p = localParts(now, safeTimeZone(timeZone));
  const backToMonday = (p.weekday + 6) % 7;
  return {
    start: new Date(Date.UTC(p.year, p.month - 1, p.day - backToMonday)),
    end: new Date(Date.UTC(p.year, p.month - 1, p.day - backToMonday + 7)),
  };
}

/** "Wednesday", for the Home header eyebrow. */
export function weekdayName(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: safeTimeZone(timeZone), weekday: "long" }).format(now);
}
