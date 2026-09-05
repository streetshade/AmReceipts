import { handler, json, requireUser } from "@/lib/api";
import { queryAudit, auditSummary, auditJobNumbers, auditUsers } from "@/lib/m3/audit";
import { filtersFromRequest } from "@/lib/m3/filters";

export const dynamic = "force-dynamic";

// GET /api/m3/postings - the posting audit trail, filtered.
//
// Scope is enforced server-side from the session, never from the query string:
// a basic user sees their own postings, an approver their groups', an admin all.
export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  const filters = await filtersFromRequest(req, user);

  const [page, summary, jobNumbers, users] = await Promise.all([
    queryAudit(filters),
    auditSummary(filters),
    auditJobNumbers(filters.userIds, filters.allUsers),
    auditUsers(filters.userIds, filters.allUsers),
  ]);

  return json({
    rows: page.rows,
    nextCursor: page.nextCursor,
    summary,
    filterOptions: { jobNumbers, users },
  });
});
