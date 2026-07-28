import { cookies } from "next/headers";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "./db";

const COOKIE_NAME = "amr_session";
const SECRET = process.env.AUTH_SECRET || "dev-secret-change-me";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

// A session cookie is `<userId>.<expiryUnixSeconds>.<hmac>`, signed with AUTH_SECRET.
// Stateless and dependency-light; swap for a proper session store in production.

function sign(payload: string): string {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function createSessionToken(userId: string): string {
  const expiry = Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS;
  const payload = `${userId}.${expiry}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expiryStr, sig] = parts;
  const payload = `${userId}.${expiryStr}`;
  if (!timingSafeEqual(sig, sign(payload))) return null;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry * 1000 < Date.now()) return null;
  return userId;
}

export function setSessionCookie(userId: string) {
  cookies().set(COOKIE_NAME, createSessionToken(userId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie() {
  cookies().delete(COOKIE_NAME);
}

/** Returns the current user id from the request cookie, or null. */
export function getUserId(): string | null {
  return verifySessionToken(cookies().get(COOKIE_NAME)?.value);
}

/** Returns the current user record, or null. */
export async function getCurrentUser() {
  const userId = getUserId();
  if (!userId) return null;
  return prisma.user.findUnique({ where: { id: userId } });
}

export async function registerUser(email: string, name: string, password: string) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new Error("An account with that email already exists.");
  const passwordHash = await bcrypt.hash(password, 10);
  return prisma.user.create({ data: { email, name, passwordHash } });
}

export async function authenticate(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? user : null;
}

export const COOKIE = COOKIE_NAME;
