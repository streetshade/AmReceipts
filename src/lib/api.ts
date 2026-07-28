import { NextResponse } from "next/server";
import { getUserId } from "./auth";

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
