// Query-string parsing for the audit trail.
//
// Lives here rather than in the route module because Next's App Router only
// permits recognised exports (GET, POST, dynamic, ...) from a route.ts; the
// export route importing a helper out of a sibling route module trips route
// validation at build time.

import { reportableUserIds } from "../access";
import type { AuditFilters } from "./audit";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Filters from the query string, intersected with what this viewer may see. */
export async function filtersFromRequest(
  req: Request,
  viewer: { id: string; role: string },
): Promise<AuditFilters> {
  const p = new URL(req.url).searchParams;
  const from = p.get("from");
  const to = p.get("to");

  // An admin is scoped by "all rows", not by "all current users" - postings
  // made by a since-deleted account must stay visible to them.
  const allUsers = viewer.role === "admin";

  return {
    allUsers,
    userIds: allUsers ? [] : await reportableUserIds(viewer),
    userId: p.get("userId") ?? undefined,
    jobNumber: p.get("jobNumber") ?? undefined,
    status: p.get("status") ?? undefined,
    // Silently ignore a malformed date rather than 400-ing a filter bar.
    from: from && DATE.test(from) ? from : undefined,
    to: to && DATE.test(to) ? to : undefined,
    search: p.get("search") ?? undefined,
    limit: Number(p.get("limit")) || undefined,
    cursor: p.get("cursor") ?? undefined,
  };
}
