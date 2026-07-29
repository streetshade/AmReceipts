import type { ExportSessionRow } from "./data";

/** Escape a value for CSV (RFC 4180): quote if it contains comma/quote/newline. */
function cell(value: string | number): string {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const HEADERS = [
  "Owner",
  "Title",
  "Company",
  "Session",
  "Project",
  "Reason",
  "Payment methods",
  "Approval",
  "Submitted",
  "Created",
  "Total (USD)",
];

/** Build a session-level CSV from export rows. */
export function buildSessionsCsv(rows: ExportSessionRow[]): string {
  const lines = [HEADERS.map(cell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.owner,
        r.title,
        r.company,
        r.session,
        r.project,
        r.reason,
        r.payment,
        r.approval,
        r.submitted,
        r.created,
        (r.totalCents / 100).toFixed(2),
      ]
        .map(cell)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
