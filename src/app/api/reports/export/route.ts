import { handler, error, requireUser } from "@/lib/api";
import { buildReport } from "@/lib/reports";
import { reportableUserIds, overseenUserIds } from "@/lib/access";
import { exportSessionRows } from "@/lib/exporters/data";
import { buildSessionsCsv } from "@/lib/exporters/csv";
import { buildReportPdf } from "@/lib/exporters/pdf";

export const dynamic = "force-dynamic";

// GET /api/reports/export?scope=self|team&format=csv|pdf
// CSV = session-level detail; PDF = formatted summary report.
export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") === "team" ? "team" : "self";
  const format = url.searchParams.get("format") === "pdf" ? "pdf" : "csv";

  if (scope === "team" && user.role !== "approver" && user.role !== "admin") {
    return error("Not authorized for team reports", 403);
  }

  const userIds = scope === "team" ? await reportableUserIds(user) : [user.id];
  const isTeam = scope === "team";
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `amreceipts-${scope}-report-${stamp}`;

  if (format === "csv") {
    const rows = await exportSessionRows(userIds);
    const csv = buildSessionsCsv(rows);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${base}.csv"`,
      },
    });
  }

  const report = await buildReport(userIds);
  const overseen = isTeam && user.role === "approver" ? (await overseenUserIds(user.id)).length : 0;
  const scopeLabel = isTeam
    ? user.role === "admin"
      ? "Team expenses — all accounts"
      : `Team expenses — ${overseen} member${overseen === 1 ? "" : "s"} you oversee`
    : "Your expenses";
  const forLine = [user.name, [user.title, user.company].filter(Boolean).join(", ")].filter(Boolean).join(" · ");

  const pdf = await buildReportPdf(report, {
    title: "Expenditure report",
    scopeLabel,
    forLine,
    generatedOn: stamp,
    isTeam,
  });

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${base}.pdf"`,
    },
  });
});
