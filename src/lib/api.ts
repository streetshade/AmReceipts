import { NextResponse } from "next/server";
import { getUserId, getCurrentUser } from "./auth";

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function error(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Guard for API routes. Returns the userId or throws a Response to return. */
export function requireUserId(): string {
  const userId = getUserId();
  if (!userId) throw error("Not authenticated", 401);
  return userId;
}

/** Guard that loads and returns the full, active user record (throws 401). */
export async function requireUser() {
  const user = await getCurrentUser();
  if (!user || !user.active) throw error("Not authenticated", 401);
  return user;
}

/** Guard requiring one of the given roles. Admin implicitly passes any check. */
export async function requireRole(...roles: string[]) {
  const user = await requireUser();
  if (user.role !== "admin" && !roles.includes(user.role)) throw error("Forbidden", 403);
  return user;
}

/** Wrap a route handler so thrown Responses become the response. */
export function handler<T extends any[]>(fn: (...args: T) => Promise<Response>) {
  return async (...args: T): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof Response) return e;
      console.error(e);
      const message = e instanceof Error ? e.message : "Internal error";
      return error(message, 500);
    }
  };
}
