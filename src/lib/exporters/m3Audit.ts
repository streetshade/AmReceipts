import type { AuditRow } from "../m3/audit";

/**
 * Escape for CSV (RFC 4180) and defuse spreadsheet formula injection.
 *
 * A merchant name or an M3 error message beginning =, +, - or @ is interpreted
 * as a formula by Excel and Sheets. This file is opened by finance staff by
 * definition, so a leading apostrophe is prepended to neutralise it - the value
 * still reads correctly in the cell.
 */
function cell(value: string | number | null | undefined): string {
  let s = String(value ?? "");
  // Leading whitespace is trimmed by spreadsheet software before it decides
  // whether a cell is a formula, so test past it rather than at position 0.
  if (/^[\s]*[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const money = (cents: number) => (cents / 100).toFixed(2);

// ---------------------------------------------------------------------------
// Line view - what was booked where
// ---------------------------------------------------------------------------

// One row PER VOUCHER LINE, not per posting. Reconciliation happens line by
// line against M3, so a posting-level export would force the person doing it to
// expand every row by hand. The posting-level fields simply repeat.
const LINE_HEADERS = [
  "Reference", "Status", "Attempts", "Ambiguous ever",
  "Claimant", "Email", "Job number", "Job name", "Group",
  "Company (CONO)", "Division (DIVI)", "Document", "Profile", "Accounting date",
  "Voucher no", "Voucher series", "Fiscal year", "Supplier",
  "Line", "Account (AIT1)", "AIT2", "AIT3", "AIT4", "AIT5", "AIT6", "AIT7",
  "VAT code", "Description", "Suspense", "Line amount", "Line tax",
  "Receipt ID", "Routed by",
  "Currency", "Posting total", "Posting tax", "Posted at", "Created at", "Last error",
  "Session ID",
];

export function buildAuditCsv(rows: AuditRow[], truncated = false): string {
  const out = [LINE_HEADERS.map(cell).join(",")];

  for (const r of rows) {
    const everAmbiguous = r.attemptLog.some((a) => a.ambiguous) ? "yes" : "";
    const head = [
      r.reference, r.status, r.attempts, everAmbiguous,
      r.user.name, r.user.email, r.job.number ?? "", r.job.name ?? "", r.groupName ?? "",
      r.cono, r.divi, r.documentType, r.postingProfileKey, r.accountingDate,
      r.voucherNo ?? "", r.voucherSeries ?? "", r.fiscalYear ?? "", r.supplierNo ?? "",
    ];
    const tail = [
      r.currency, money(r.amountCents), money(r.taxCents),
      r.postedAt ?? "", r.createdAt, r.lastError ?? "", r.sessionId,
    ];

    // A posting with no lines still emits a row. An attempt that never got as
    // far as building lines is exactly what a reconciler is hunting for, and
    // dropping it would make the export look tidier than the truth.
    if (r.lines.length === 0) {
      // Column positions must line up with the header even when there is no
      // line data, so the placeholder is written into the description slot.
      const blanks = ["", "", "", "", "", "", "", "", ""]; // line..AIT7, VAT
      out.push(row([...head, ...blanks, "(no lines built)", "", "", "", "", "", ...tail], LINE_HEADERS.length));
      continue;
    }

    for (const l of r.lines) {
      out.push(row([
        ...head,
        l.lineNo, l.account, ...l.dimensions.map((d) => d ?? ""),
        l.vatCode ?? "", l.description, l.viaSuspense ? "yes" : "",
        money(l.amountCents), money(l.taxCents),
        l.receiptId ?? "", l.routedBy.join(" "),
        ...tail,
      ], LINE_HEADERS.length));
    }
  }

  return finish(out, truncated, LINE_HEADERS.length);
}

// ---------------------------------------------------------------------------
// Attempt view - what was tried, and what M3 said
// ---------------------------------------------------------------------------

// The line view shows the intended booking; this one shows the conversation.
// They are separate exports rather than one join because a posting has both
// lines and attempts, and crossing them would multiply rows into nonsense.
const ATTEMPT_HEADERS = [
  "Reference", "Posting status", "Claimant", "Job number",
  "Attempt", "Outcome", "Ambiguous", "Committing call", "Started", "Finished", "Duration (ms)",
  "Actor", "Program", "Transaction", "HTTP", "Voucher returned", "M3 message",
  "Request parameters",
];

export function buildAttemptsCsv(rows: AuditRow[], truncated = false): string {
  const out = [ATTEMPT_HEADERS.map(cell).join(",")];

  for (const r of rows) {
    if (r.attemptLog.length === 0) {
      out.push(row([r.reference, r.status, r.user.name, r.job.number ?? "", "", "(never attempted)"],
        ATTEMPT_HEADERS.length));
      continue;
    }
    for (const a of r.attemptLog) {
      out.push(row([
        r.reference, r.status, r.user.name, r.job.number ?? "",
        a.attemptNo, a.outcome, a.ambiguous ? "yes" : "", a.commits ? "yes" : "",
        a.startedAt, a.finishedAt ?? "", a.durationMs ?? "",
        a.actor, a.program ?? "", a.transaction ?? "", a.httpStatus ?? "",
        a.voucherNo ?? "", a.m3Message ?? "",
        a.requestParams ? JSON.stringify(a.requestParams) : "",
      ], ATTEMPT_HEADERS.length));
    }
  }

  return finish(out, truncated, ATTEMPT_HEADERS.length);
}

/**
 * Terminate the file, marking truncation in the DATA rather than a header.
 *
 * A browser downloading via a plain link never surfaces a response header, so
 * an X-Export-Truncated of "true" is invisible to the person who then treats a
 * capped file as a complete period. A visible last row cannot be missed.
 */
/** Pad a row to the header width so strict CSV importers stay happy. */
function row(values: (string | number | null | undefined)[], width: number): string {
  const padded = [...values];
  while (padded.length < width) padded.push("");
  return padded.slice(0, width).map(cell).join(",");
}

function finish(out: string[], truncated: boolean, width: number): string {
  if (truncated) {
    out.push(row([], width));
    out.push(row(
      ["*** TRUNCATED: more postings matched than this export can hold. Narrow the date range and export again. ***"],
      width,
    ));
  }
  return out.join("\r\n") + "\r\n";
}
