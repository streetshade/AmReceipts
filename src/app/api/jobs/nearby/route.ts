import { z } from "zod";
import { prisma } from "@/lib/db";
import { handler, json, error, requireUserId } from "@/lib/api";
import { matchSite, siteLabel, type JobSite } from "@/lib/geo";

// Which job the caller is standing on.
//
// The match is made HERE rather than in the browser so a phone never has to
// hold the coordinates of every site the company works on - a list that is not
// the technician's to carry around, and that would sit in a cache long after
// they left the company. The cost is that this needs signal; the screen says so
// and offers the picker instead, rather than pretending it matched.

// Reads the session cookie and the query string, so there is nothing to
// prerender. Declared rather than inferred, as the other authenticated routes
// in this app do.
export const dynamic = "force-dynamic";

/**
 * A query parameter that must be a number if it is there at all.
 *
 * `z.coerce.number()` alone is a trap here: `Number(null)` and `Number("")`
 * are both 0, so a request with no coordinates at all validated cleanly as a
 * position off the coast of Africa - and would have matched a site near it.
 */
// Whitespace counts as blank too: `Number(" ")` is 0, so `lat=%20` would
// otherwise have slipped through as a position on the equator.
const blank = (v: unknown) =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "") ? undefined : v;

/** Present and a real number, within bounds. */
const numeric = (min: number, max: number) =>
  z.preprocess(blank, z.coerce.number().finite().min(min).max(max));

/**
 * Absent, or a real number.
 *
 * The `optional()` has to sit INSIDE the preprocess, not after it: applied
 * outside, an empty `accuracy=` reaches the pipeline as `""`, is blanked to
 * `undefined`, and is then coerced to NaN and rejected - turning a browser that
 * omits an accuracy figure into a 422 rather than a cautious match.
 */
const optionalNumeric = (min: number, max: number) =>
  z.preprocess(blank, z.coerce.number().finite().min(min).max(max).optional());

const Query = z.object({
  lat: numeric(-90, 90),
  lng: numeric(-180, 180),
  // The browser always sends this; it is what makes a confident match
  // defensible. Absent, the matcher treats the fix as unusable rather than
  // perfect.
  accuracy: optionalNumeric(0, Number.MAX_SAFE_INTEGER),
});

/** What the client needs to draw a job, and nothing else. */
function shape(job: JobSite) {
  return {
    id: job.id,
    number: job.number,
    name: job.name,
    address: job.address,
    label: siteLabel(job),
  };
}

export const GET = handler(async (req: Request) => {
  const userId = requireUserId();
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    lat: url.searchParams.get("lat"),
    lng: url.searchParams.get("lng"),
    accuracy: url.searchParams.get("accuracy"),
  });
  if (!parsed.success) return error("A latitude and longitude are required", 422);

  const jobs = await prisma.job.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      number: true,
      name: true,
      address: true,
      latitude: true,
      longitude: true,
      radiusMetres: true,
    },
  });

  const result = matchSite(jobs, {
    latitude: parsed.data.lat,
    longitude: parsed.data.lng,
    // Undefined becomes Infinity in the matcher, which refuses to assert.
    accuracyMetres: parsed.data.accuracy ?? Number.POSITIVE_INFINITY,
  });

  return json({
    reason: result.reason,
    match: result.match
      ? { ...shape(result.match.site), distanceMetres: result.match.distanceMetres }
      : null,
    candidates: result.candidates.map((c) => ({ ...shape(c.site), distanceMetres: c.distanceMetres })),
    // The fallback list, so a screen that could not match still offers
    // something better than a text field. Capped: this is a picker, not a
    // directory.
    recent: jobs.slice(0, 8).map(shape),
  });
});
