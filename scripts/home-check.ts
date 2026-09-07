// Checks for the field Home screen's maths.
//
//   npm run check:home
//
// Two things are being defended here.
//
// The site matcher decides which job a day of receipts is booked against. It
// says so on screen as a fact, and the technician taps `Log here` without
// reading it twice - so the interesting cases are all the ones where it must
// REFUSE to answer rather than guess plausibly.
//
// The day and week boundaries decide whether the "Today" card agrees with the
// paper in someone's pocket. They are the sort of thing that works all year and
// then goes wrong on two Sundays in the spring.

import {
  DEFAULT_RADIUS_METRES,
  MAX_FIX_ACCURACY_METRES,
  MAX_RADIUS_METRES,
  distanceMetres,
  isValidPosition,
  matchSite,
  siteLabel,
  siteRadius,
  type JobSite,
} from "../src/lib/geo";
import {
  calendarDayRange,
  calendarWeekRange,
  dayRange,
  localParts,
  safeTimeZone,
  weekRange,
  weekdayName,
} from "../src/lib/timeRange";
import { VISIT_STATUS_LABEL, greetingFor, relativeDay, visitStatus, visitTitle } from "../src/lib/homeSummary";

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "  ok  " : "  FAIL"} ${name}${detail && !passed ? ` — ${detail}` : ""}`);
  if (!passed) failures++;
}

// ---------------------------------------------------------------- distances

// Two points about 1.6km apart in Vancouver, checked against a map.
const vanCityHall = { lat: 49.2606, lng: -123.1139 };
const scienceWorld = { lat: 49.2733, lng: -123.1038 };
const d = distanceMetres(vanCityHall.lat, vanCityHall.lng, scienceWorld.lat, scienceWorld.lng);
check("a known 1.6km hop measures within 5%", Math.abs(d - 1590) < 80, `${Math.round(d)}m`);
check("a point is zero metres from itself", distanceMetres(49.26, -123.11, 49.26, -123.11) === 0);
check("distance is symmetric", Math.abs(distanceMetres(1, 2, 3, 4) - distanceMetres(3, 4, 1, 2)) < 1e-6);
// One degree of latitude is ~111.2km anywhere on the globe.
check("one degree of latitude is ~111km", Math.abs(distanceMetres(0, 0, 1, 0) - 111_195) < 200);
// The border-crossing case the estate actually has: large negative longitudes.
check(
  "a 100m step near the 49th parallel measures ~100m",
  Math.abs(distanceMetres(49.0, -123.0, 49.0009, -123.0) - 100) < 3,
);
// The antimeridian. A bounding-box prefilter would call these 360 degrees apart.
check(
  "either side of the antimeridian is metres apart, not half a world",
  distanceMetres(0, 179.9995, 0, -179.9995) < 200,
  String(Math.round(distanceMetres(0, 179.9995, 0, -179.9995))),
);
// Antipodal points: the haversine argument can float above 1 and produce NaN.
check("antipodal points do not produce NaN", Number.isFinite(distanceMetres(0, 0, -0, 180)));

check("a valid position is accepted", isValidPosition(49.26, -123.11));
check("a latitude past the pole is refused", !isValidPosition(91, 0));
check("a longitude past the date line is refused", !isValidPosition(0, 181));
check("NaN is refused", !isValidPosition(NaN, 0));
check("a string that looks like a number is refused", !isValidPosition("49.26" as unknown as number, -123.11));

// ------------------------------------------------------------------ radius

const bare: JobSite = {
  id: "j",
  number: "1",
  name: null,
  address: null,
  latitude: 0,
  longitude: 0,
  radiusMetres: null,
};
check("no radius takes the default", siteRadius(bare) === DEFAULT_RADIUS_METRES);
check("a radius of zero takes the default", siteRadius({ ...bare, radiusMetres: 0 }) === DEFAULT_RADIUS_METRES);
check("a negative radius takes the default", siteRadius({ ...bare, radiusMetres: -5 }) === DEFAULT_RADIUS_METRES);
check(
  "metres mistyped as a distance in metres-of-kilometres is capped",
  siteRadius({ ...bare, radiusMetres: 250_000 }) === MAX_RADIUS_METRES,
);

// ------------------------------------------------------------------ matching

function site(id: string, lat: number, lng: number, radius: number | null = null): JobSite {
  return { id, number: id, name: `Site ${id}`, address: `${id} Road`, latitude: lat, longitude: lng, radiusMetres: radius };
}

const riverside = site("4821", 49.2600, -123.1100);
// ~1.6km away, comfortably a different place.
const oakridge = site("4822", 49.2733, -123.1038);
const good = { latitude: 49.2601, longitude: -123.1100, accuracyMetres: 12 };

const matched = matchSite([riverside, oakridge], good);
check("a good fix on one site matches it", matched.reason === "matched" && matched.match?.site.id === "4821");
check("a match carries a rounded distance", Number.isInteger(matched.match?.distanceMetres ?? 0.5));
check("a match offers no candidates", matched.candidates.length === 0);

check(
  "a fix well away from every site matches nothing",
  matchSite([riverside, oakridge], { latitude: 49.5, longitude: -123.5, accuracyMetres: 10 }).reason === "no-site-near",
);
check(
  "sites with no coordinates cannot match",
  matchSite([{ ...riverside, latitude: null, longitude: null }], good).reason === "no-sites-located",
);
check("an empty job list matches nothing", matchSite([], good).reason === "no-sites-located");

// The dangerous case: a town-sized fix that would otherwise "match" whichever
// site happened to be listed first.
check(
  "a town-sized fix refuses to pick",
  matchSite([riverside, oakridge], { latitude: 49.2601, longitude: -123.1100, accuracyMetres: 4000 }).reason ===
    "fix-too-vague",
);
check(
  "a fix exactly at the accuracy limit is still usable",
  matchSite([riverside], { latitude: 49.2601, longitude: -123.11, accuracyMetres: MAX_FIX_ACCURACY_METRES }).reason ===
    "matched",
);
check(
  "one metre past the accuracy limit is not",
  matchSite([riverside], { latitude: 49.2601, longitude: -123.11, accuracyMetres: MAX_FIX_ACCURACY_METRES + 1 })
    .reason === "fix-too-vague",
);
check(
  "a missing accuracy is treated as the worst case, not the best",
  matchSite([riverside], {
    latitude: 49.2601,
    longitude: -123.11,
    accuracyMetres: undefined as unknown as number,
  }).reason === "fix-too-vague",
);
check(
  "an infinite accuracy is refused",
  matchSite([riverside], { latitude: 49.2601, longitude: -123.11, accuracyMetres: Infinity }).reason === "fix-too-vague",
);
check(
  "a fix with no position at all is refused",
  matchSite([riverside], { latitude: NaN, longitude: -123.11, accuracyMetres: 5 }).reason === "fix-too-vague",
);

// Two sites in one yard, 30m apart, both with the default 250m circle: the
// position is inside both, so there is no honest way to pick one.
const yardA = site("A", 49.2600, -123.1100);
const yardB = site("B", 49.26027, -123.1100);
const ambiguous = matchSite([yardA, yardB], { latitude: 49.26010, longitude: -123.11, accuracyMetres: 60 });
check("two sites whose circles both contain the fix are ambiguous", ambiguous.reason === "ambiguous");
check("an ambiguous result asserts no match", ambiguous.match === null);
check("an ambiguous result offers both to choose from", ambiguous.candidates.length === 2);
check("candidates come back nearest first", ambiguous.candidates[0].site.id === "A");
check(
  "even a pinpoint fix will not choose between two overlapping circles",
  matchSite([yardA, yardB], { latitude: 49.26001, longitude: -123.11, accuracyMetres: 5 }).reason === "ambiguous",
);
check(
  "tightening the circles to match reality resolves the same pair",
  matchSite([site("A", 49.26, -123.11, 10), site("B", 49.26027, -123.11, 10)], {
    latitude: 49.26001,
    longitude: -123.11,
    accuracyMetres: 5,
  }).match?.site.id === "A",
);
// The case a centre-distance comparison got wrong: a small site under the fix
// and a huge yard 400m off that also swallows it.
check(
  "a wide site that also contains the fix is a rival, however far its centre is",
  matchSite([site("small", 49.26, -123.11, 50), site("yard", 49.2636, -123.11, 5000)], {
    latitude: 49.26,
    longitude: -123.11,
    accuracyMetres: 20,
  }).reason === "ambiguous",
);

// A tight fix a little outside the circle: the browser's own error should still
// let the tech standing at the gate match.
check(
  "the site's circle is widened by the fix's admitted error",
  matchSite([site("C", 49.26, -123.11, 100)], { latitude: 49.26243, longitude: -123.11, accuracyMetres: 200 }).reason ===
    "matched",
);
check(
  "but not indefinitely",
  matchSite([site("C", 49.26, -123.11, 100)], { latitude: 49.2700, longitude: -123.11, accuracyMetres: 200 }).reason ===
    "no-site-near",
);

// Ordering must not depend on the order the database happened to return.
const tightA = site("A", 49.26, -123.11, 10);
const tightB = site("B", 49.26027, -123.11, 10);
const at = { latitude: 49.26001, longitude: -123.11, accuracyMetres: 5 };
check(
  "the result does not depend on job order",
  matchSite([tightA, tightB], at).match?.site.id === matchSite([tightB, tightA], at).match?.site.id,
);

check("a named job reads name then number", siteLabel({ number: "4821", name: "Riverside" }) === "Riverside · 4821");
check("an unnamed job is just the number", siteLabel({ number: "4821", name: null }) === "4821");

// ---------------------------------------------------------------- calendars

const TZ = "America/Vancouver";
check("a real zone survives validation", safeTimeZone(TZ) === TZ);
check("a nonsense zone falls back to UTC rather than throwing", safeTimeZone("Mars/Olympus") === "UTC");

// Mid-afternoon in Vancouver on a Wednesday, which is the next day in UTC.
const wed = new Date("2026-09-02T22:30:00Z"); // 15:30 PDT
const wedDay = dayRange(wed, TZ);
check("the day starts at local midnight", wedDay.start.toISOString() === "2026-09-02T07:00:00.000Z", wedDay.start.toISOString());
check("the day ends at the next local midnight", wedDay.end.toISOString() === "2026-09-03T07:00:00.000Z", wedDay.end.toISOString());
check("the instant is inside its own day", wed >= wedDay.start && wed < wedDay.end);
check("the weekday is the local one, not UTC's", weekdayName(wed, TZ) === "Wednesday", weekdayName(wed, TZ));
check("local parts read the local hour", localParts(wed, TZ).hour === 15);

// The trap: 6pm Pacific is already tomorrow in UTC. A UTC boundary would put
// this receipt on the wrong card.
const evening = new Date("2026-09-03T02:30:00Z"); // 19:30 PDT on the 2nd
check("an evening receipt stays on the local day it was bought", evening >= wedDay.start && evening < wedDay.end);
check("that day is still Wednesday locally", weekdayName(evening, TZ) === "Wednesday");

// Weeks run Monday to Monday.
const wedWeek = weekRange(wed, TZ);
check("the week starts on Monday local midnight", wedWeek.start.toISOString() === "2026-08-31T07:00:00.000Z", wedWeek.start.toISOString());
check("the week ends the following Monday", wedWeek.end.toISOString() === "2026-09-07T07:00:00.000Z", wedWeek.end.toISOString());
check("today sits inside this week", wedDay.start >= wedWeek.start && wedDay.end <= wedWeek.end);

// Sunday must belong to the week that began six days earlier, not the next one.
const sunday = new Date("2026-09-06T19:00:00Z"); // 12:00 PDT Sunday
check("Sunday closes the week rather than opening one", weekRange(sunday, TZ).start.toISOString() === "2026-08-31T07:00:00.000Z");
const monday = new Date("2026-09-07T15:00:00Z"); // 08:00 PDT Monday
check("Monday opens a new week", weekRange(monday, TZ).start.toISOString() === "2026-09-07T07:00:00.000Z");

// Daylight saving. Spring forward 2026-03-08, fall back 2026-11-01, both in
// the Pacific zone, both at 2am local.
const springForward = dayRange(new Date("2026-03-08T20:00:00Z"), TZ);
check("the spring-forward day is 23 hours long", springForward.end.getTime() - springForward.start.getTime() === 23 * 3600_000);
const fallBack = dayRange(new Date("2026-11-01T19:00:00Z"), TZ);
check("the fall-back day is 25 hours long", fallBack.end.getTime() - fallBack.start.getTime() === 25 * 3600_000);
// 5 March 2026 is the Thursday of the week that CONTAINS the spring-forward
// Sunday (8 March), which is the week that is an hour short.
const dstWeek = weekRange(new Date("2026-03-05T20:00:00Z"), TZ);
check(
  "the week containing a clock change is still seven calendar days",
  dstWeek.end.getTime() - dstWeek.start.getTime() === 7 * 24 * 3600_000 - 3600_000,
);

// A day boundary must never be empty or inverted, in any zone, on any day of a
// year that contains two clock changes in most of them.
let boundariesSane = true;
for (const tz of ["America/Vancouver", "America/Toronto", "UTC", "Australia/Lord_Howe", "Asia/Kathmandu", "Pacific/Chatham"]) {
  for (let day = 0; day < 365; day++) {
    const at = new Date(Date.UTC(2026, 0, 1, 12) + day * 24 * 3600_000);
    const r = dayRange(at, tz);
    const w = weekRange(at, tz);
    if (!(r.start <= at && at < r.end)) { boundariesSane = false; break; }
    if (!(w.start <= at && at < w.end)) { boundariesSane = false; break; }
    if (!(r.start >= w.start && r.end <= w.end)) { boundariesSane = false; break; }
  }
  if (!boundariesSane) break;
}
check("every day of 2026 lands inside its own day and week, in six zones", boundariesSane);

// Half-hour and 45-minute zones, where a naive offset in whole hours is wrong.
const kathmandu = dayRange(new Date("2026-09-02T20:00:00Z"), "Asia/Kathmandu");
check("a 45-minute offset zone starts on the quarter hour", kathmandu.start.toISOString() === "2026-09-02T18:15:00.000Z", kathmandu.start.toISOString());

// --------------------------------------------------- date-only purchase dates

// A receipt's purchaseDate is a CALENDAR DATE stored at UTC midnight, by both
// the date field on the editor and the OCR reader. Compared against the zoned
// instants above it lands on the wrong side of the boundary by the offset.
const calDay = calendarDayRange(wed, TZ);
const calWeek = calendarWeekRange(wed, TZ);
check("the calendar day is the local date at UTC midnight", calDay.start.toISOString() === "2026-09-02T00:00:00.000Z", calDay.start.toISOString());
check("the calendar day ends at the next UTC midnight", calDay.end.toISOString() === "2026-09-03T00:00:00.000Z");
check("the calendar week starts on the local Monday", calWeek.start.toISOString() === "2026-08-31T00:00:00.000Z");
check("the calendar week ends the following Monday", calWeek.end.toISOString() === "2026-09-07T00:00:00.000Z");

// The bug this pair exists to fix: a receipt dated today, written the way the
// editor writes it, must count as today.
const datedToday = new Date("2026-09-02T00:00:00Z");
check("a receipt dated today counts as today", datedToday >= calDay.start && datedToday < calDay.end);
check(
  "and would NOT have, compared against the zoned day",
  !(datedToday >= wedDay.start && datedToday < wedDay.end),
);
const datedMonday = new Date("2026-08-31T00:00:00Z");
check("a receipt dated Monday is in this week", datedMonday >= calWeek.start && datedMonday < calWeek.end);
check("a receipt dated the Sunday before is not", new Date("2026-08-30T00:00:00Z") < calWeek.start);
check("the calendar week contains the calendar day", calDay.start >= calWeek.start && calDay.end <= calWeek.end);
// A stub-provider date carries a time of day; it must still land on its own day.
check(
  "a dated receipt with a time on it still lands on that calendar day",
  new Date("2026-09-02T18:30:00Z") >= calDay.start && new Date("2026-09-02T18:30:00Z") < calDay.end,
);

let calSane = true;
for (const tz of ["America/Vancouver", "Asia/Kathmandu", "UTC", "Pacific/Chatham"]) {
  for (let dayN = 0; dayN < 365; dayN++) {
    const at = new Date(Date.UTC(2026, 0, 1, 12) + dayN * 24 * 3600_000);
    const cd = calendarDayRange(at, tz);
    const cw = calendarWeekRange(at, tz);
    if (cd.end.getTime() - cd.start.getTime() !== 24 * 3600_000) { calSane = false; break; }
    if (cw.end.getTime() - cw.start.getTime() !== 7 * 24 * 3600_000) { calSane = false; break; }
    if (!(cd.start >= cw.start && cd.end <= cw.end)) { calSane = false; break; }
    // The calendar bounds must name the same local date the zoned ones do.
    const p = localParts(at, tz);
    if (cd.start.toISOString().slice(0, 10) !== `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`) {
      calSane = false;
      break;
    }
  }
  if (!calSane) break;
}
check("calendar days are always 24h, weeks 7 days, and name the local date", calSane);

// ------------------------------------------------------------------ wording

check("a submitted visit is waiting on approval", visitStatus({ approvalStatus: "submitted" }) === "waiting");
check("a rejected visit was sent back", visitStatus({ approvalStatus: "rejected" }) === "sent-back");
check("an approved visit is approved", visitStatus({ approvalStatus: "approved" }) === "approved");
check("a draft visit is collecting", visitStatus({ approvalStatus: "draft" }) === "collecting");
check("an unrecognised status is collecting, not blank", visitStatus({ approvalStatus: "weird" }) === "collecting");
check("every status has words", Object.values(VISIT_STATUS_LABEL).every((l) => l.length > 0));
check("no status label is jargon from the schema", !Object.values(VISIT_STATUS_LABEL).some((l) => /draft|assigned|open/i.test(l)));

check("a named job titles the visit", visitTitle({ name: "x", job: { number: "4821", name: "Riverside" } }) === "Riverside · 4821");
check("an unnamed job falls back to its number", visitTitle({ name: "x", job: { number: "4821", name: null } }) === "4821");
check("a visit with no job keeps its own name", visitTitle({ name: "Tuesday run", job: null }) === "Tuesday run");

// "Yesterday" is the calendar day before, which is 23 or 25 hours long on the
// two weekends a year that a fixed 24-hour subtraction gets wrong.
check("today reads as Today", relativeDay(wed, wed, TZ) === "Today");
check("the day before reads as Yesterday", relativeDay(new Date("2026-09-01T22:30:00Z"), wed, TZ) === "Yesterday");
check("two days before is a date", relativeDay(new Date("2026-08-31T22:30:00Z"), wed, TZ) === "31 Aug");
// The morning after the fall-back Sunday, which was 25 hours long. Its first
// hour is more than 24 hours before today's midnight.
const afterFallBack = new Date("2026-11-02T17:00:00Z"); // Monday 09:00 PST
check(
  "the first hour of a 25-hour yesterday is still Yesterday",
  relativeDay(new Date("2026-11-01T07:30:00Z"), afterFallBack, TZ) === "Yesterday",
  relativeDay(new Date("2026-11-01T07:30:00Z"), afterFallBack, TZ),
);
// The morning after the spring-forward Sunday, which was 23 hours long.
const afterSpring = new Date("2026-03-09T16:00:00Z"); // Monday 09:00 PDT
check(
  "a 23-hour yesterday does not reach into the day before it",
  relativeDay(new Date("2026-03-07T20:00:00Z"), afterSpring, TZ) === "7 Mar",
  relativeDay(new Date("2026-03-07T20:00:00Z"), afterSpring, TZ),
);
check(
  "and that yesterday itself still reads as Yesterday",
  relativeDay(new Date("2026-03-08T20:00:00Z"), afterSpring, TZ) === "Yesterday",
);

check("before noon is morning", greetingFor(0) === "Morning" && greetingFor(11) === "Morning");
check("noon is afternoon", greetingFor(12) === "Afternoon" && greetingFor(17) === "Afternoon");
check("six is evening", greetingFor(18) === "Evening" && greetingFor(23) === "Evening");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
