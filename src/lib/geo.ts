// Matching a position to a job site.
//
// The field design attaches a job automatically from location and shows it as a
// statement of fact - "You're on site at Riverside · 4821 ... matched from your
// location". That confidence has to be earned, because the failure is not a
// wrong pixel: the technician taps `Log here`, a day of receipts lands on the
// wrong job, and it is found weeks later by whoever reconciles the ledger.
//
// So the rules here are deliberately conservative. A fix that is too vague to
// distinguish two sites does not pick one; it says so, and the screen asks.

/** A position from `navigator.geolocation`, or anything shaped like one. */
export interface Fix {
  latitude: number;
  longitude: number;
  /** Radius of the 95% confidence circle, in metres, as the browser reports it. */
  accuracyMetres: number;
}

export interface JobSite {
  id: string;
  number: string;
  name: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  radiusMetres: number | null;
}

export interface SiteMatch {
  site: JobSite;
  /** Distance from the fix to the site centre, metres, rounded. */
  distanceMetres: number;
}

export interface MatchResult {
  /** The single site the fix is confidently on, or null. */
  match: SiteMatch | null;
  /**
   * Sites the fix could plausibly be on when it is not confident enough to
   * choose. Empty when `match` is set. The screen offers these as a short list
   * rather than asserting one of them.
   */
  candidates: SiteMatch[];
  /** Why there is no match, for copy that says something useful. */
  reason: "matched" | "ambiguous" | "no-site-near" | "fix-too-vague" | "no-sites-located";
}

/** How close counts as "here" when a job carries no radius of its own. */
export const DEFAULT_RADIUS_METRES = 250;

/**
 * The widest a site's circle may be set to.
 *
 * Without a ceiling a mistyped radius - 250000 for 250km rather than metres -
 * swallows every other site in the region and matches from another city.
 */
export const MAX_RADIUS_METRES = 5_000;

/**
 * The vaguest fix that may still assert a match.
 *
 * A browser with no GPS falls back to network positioning, which on a mobile
 * carrier can be accurate to a whole town and still be reported as a position.
 * Beyond this the fix is treated as "we don't know where you are" rather than
 * being averaged into a confident-looking answer.
 */
export const MAX_FIX_ACCURACY_METRES = 500;

const EARTH_RADIUS_METRES = 6_371_008.8; // IUGG mean radius

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Whether a latitude/longitude pair is a real position on the globe. */
export function isValidPosition(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than an equirectangular approximation, and with no bounding
 * box prefilter, because both of those break across the antimeridian - and the
 * estate this serves spans the US/Canada border, where longitudes are large and
 * negative and a naive box is exactly the kind of thing that works in testing.
 */
export function distanceMetres(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  // Clamped: floating error can push h a hair above 1 for antipodal points,
  // and Math.asin of that is NaN.
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** A site's effective radius, defaulted and bounded. */
export function siteRadius(site: JobSite): number {
  const r = site.radiusMetres;
  if (typeof r !== "number" || !Number.isFinite(r) || r <= 0) return DEFAULT_RADIUS_METRES;
  return Math.min(r, MAX_RADIUS_METRES);
}

/**
 * Which job site a fix is on.
 *
 * Confident only when ONE site is in range and no other site is close enough
 * that the fix's own error could account for the difference. Two sites in the
 * same yard, or a vague fix straddling both, returns them as candidates - the
 * screen asks rather than guessing, which is the whole point of the accuracy
 * figure the browser hands us and which most code throws away.
 */
export function matchSite(sites: JobSite[], fix: Fix): MatchResult {
  const located = sites.filter((s) => isValidPosition(s.latitude, s.longitude));
  if (located.length === 0) {
    return { match: null, candidates: [], reason: "no-sites-located" };
  }

  if (!isValidPosition(fix.latitude, fix.longitude)) {
    return { match: null, candidates: [], reason: "fix-too-vague" };
  }
  // A missing or nonsensical accuracy is treated as the worst case, not the
  // best. `accuracy` is required by the geolocation spec but has been seen
  // absent behind polyfills and in-app browsers.
  const accuracy =
    typeof fix.accuracyMetres === "number" && Number.isFinite(fix.accuracyMetres) && fix.accuracyMetres >= 0
      ? fix.accuracyMetres
      : Number.POSITIVE_INFINITY;
  if (accuracy > MAX_FIX_ACCURACY_METRES) {
    return { match: null, candidates: [], reason: "fix-too-vague" };
  }

  const measured: SiteMatch[] = located
    .map((site) => ({
      site,
      distanceMetres: Math.round(
        distanceMetres(fix.latitude, fix.longitude, site.latitude as number, site.longitude as number),
      ),
    }))
    .sort((a, b) => a.distanceMetres - b.distanceMetres || a.site.id.localeCompare(b.site.id));

  // In range on the fix's own terms: the site's circle, widened by the error
  // the browser admits to. Ignoring accuracy here would refuse a correct match
  // whenever the tech is indoors.
  const inRange = measured.filter((m) => m.distanceMetres <= siteRadius(m.site) + accuracy);
  if (inRange.length === 0) {
    return { match: null, candidates: [], reason: "no-site-near" };
  }

  // More than one site could contain the fix, so the fix does not identify one.
  //
  // An earlier version compared centre distances against the accuracy figure
  // instead, and asserted a match whenever the runner-up's centre was further
  // away than the error bar. That ignores the sites' own radii: a fix 20m from
  // a small site's centre also sits well inside a 5km yard 400m away, and the
  // yard is just as likely to be the right answer. Being in range at all is
  // already the test for "could be here" - anything past one is a question for
  // the technician.
  if (inRange.length > 1) {
    return { match: null, candidates: inRange, reason: "ambiguous" };
  }

  return { match: inRange[0], candidates: [], reason: "matched" };
}

/** "Riverside · 4821", the way the banner names a job. */
export function siteLabel(site: { number: string; name: string | null }): string {
  return site.name ? `${site.name} · ${site.number}` : site.number;
}
