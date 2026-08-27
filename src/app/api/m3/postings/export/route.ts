import { handler, requireUser } from "@/lib/api";
import { queryAudit } from "@/lib/m3/audit";
import { buildAuditCsv, buildAttemptsCsv } from "@/lib/exporters/m3Audit";
import { filtersFromRequest } from "@/lib/m3/filters";

export const dynamic = "force-dynamic";

// A reconciliation pass covers a period, not a screen, so the export ignores
// the UI page size. Capped so one request cannot try to serialise the entire
// history into memory.
const EXPORT_LIMIT = 5000;

// GET /api/m3/postings/export?view=lines|attempts
//
// lines    - one row per voucher line: what was booked where.
// attempts - one row per attempt: what was tried and what M3 said.
export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  const filters = await filtersFromRequest(req, user);
  const view = new URL(req.url).searchParams.get("view") === "attempts" ? "attempts" : "lines";

  const { rows, nextCursor } = await queryAudit({
    ...filters,
    limit: EXPORT_LIMIT,
    // The UI's 200-row page cap would otherwise silently truncate every export.
    maxLimit: EXPORT_LIMIT,
    cursor: undefined,
  });
  const truncated = nextCursor !== null;
  const csv = view === "attempts" ? buildAttemptsCsv(rows, truncated) : buildAuditCsv(rows, truncated);
  const stamp = new Date().toISOString().slice(0, 10);

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="m3-postings-${view}-${stamp}.csv"`,
      // Belt and braces: the file itself also ends with a visible truncation
      // row, because a browser download never shows a response header.
      "X-Export-Truncated": truncated ? "true" : "false",
    },
  });
});
