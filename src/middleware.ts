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

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));
  const authed = looksAuthed(req.cookies.get("amr_session")?.value);

  if (!authed && !isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (authed && isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|uploads|favicon.ico).*)"],
};
