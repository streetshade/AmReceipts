"use client";

// Whether it is safe to ask the server for anything.
//
// This exists because of a failure that is much worse than it sounds. Calling
// `router.refresh()` with no connection makes Next fail to fetch the RSC
// payload, log "Falling back to browser navigation", and perform a full page
// load - which also fails, leaving `<html><head></head><body></body></html>`.
// The app is GONE, and with it the burst of photographs held in memory, on a
// screen whose entire promise is that it works without signal.
//
// So a refresh needs a reason to believe the server is reachable. There are two
// kinds of evidence, in increasing order of trust:
//
//   1. `navigator.onLine` is not false. Famously unreliable when it says TRUE -
//      a captive portal or a dead cell both report online - but reliable when
//      it says false, which is the direction that matters here.
//   2. A request to our own server that just came back. That is proof, and it
//      is what the review screen uses: it fetches the session before refreshing
//      rather than taking the browser's word for it.
//
// Prefer (2) wherever a refresh would cost something to get wrong. Use (1) for
// the cases where a refresh is merely a nice-to-have and a probe would be more
// traffic than the refresh is worth.

/** False only when the browser is certain there is no connection. */
export function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}
