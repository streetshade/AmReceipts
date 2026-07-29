import { NextRequest, NextResponse } from "next/server";

// Lightweight UX guard only: checks the session cookie is present and unexpired.
// The cryptographic signature is verified server-side in every page/route via
// getCurrentUser()/requireUserId(), which is where real authorization happens.
const PUBLIC_PATHS = ["/login", "/register"];

function looksAuthed(token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const expiry = Number(parts[1]);
  return Number.isFinite(expiry) && expiry * 1000 > Date.now();
}

// Build an absolute redirect URL from the *incoming* request headers rather than
// req.nextUrl. Under `next start` behind a reverse proxy, req.nextUrl carries the
// internal origin (localhost:3000), so redirects built from it point at the wrong
// host. The forwarded Host/proto headers (set by nginx) give the real public URL.
function redirectTo(req: NextRequest, pathname: string): NextResponse {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host) {
    // No host header (shouldn't happen behind nginx) — fall back to nextUrl.
    const url = req.nextUrl.clone();
    url.pathname = pathname;
    return NextResponse.redirect(url);
  }
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(/:$/, "");
  return NextResponse.redirect(`${proto}://${host}${pathname}`);
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));
  const authed = looksAuthed(req.cookies.get("amr_session")?.value);

  if (!authed && !isPublic) return redirectTo(req, "/login");
  if (authed && isPublic) return redirectTo(req, "/dashboard");
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|uploads|brand|favicon.ico).*)"],
};
