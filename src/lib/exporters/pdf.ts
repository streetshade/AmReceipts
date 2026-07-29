import path from "path";
import { promises as fs } from "fs";
import PDFDocument from "pdfkit";
import type { ReportData, ReportRow } from "../reports";
import { formatCents } from "../money";

export interface PdfMeta {
  title: string; // e.g. "Expenditure report"
  scopeLabel: string; // e.g. "Your expenses" / "Team expenses"
  forLine: string; // e.g. "Demo User · Field Technician, Samaritech"
  generatedOn: string; // ISO date string (passed in; no Date() here)
  isTeam: boolean;
}

// Brand palette (dark accents that read on a white page).
const INK = "#152522";
const MUTED = "#5c6b67";
const TEAL = "#0E7C6B";
const GOLD = "#A8863B";
const LINE = "#d8e0dd";

function toBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

export async function buildReportPdf(report: ReportData, meta: PdfMeta): Promise<Buffer> {
  const doc = new PDFDocument({ size: "LETTER", margin: 50 });
  const bufferPromise = toBuffer(doc);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  // --- Header with logo ---
  try {
    const logo = await fs.readFile(path.join(process.cwd(), "public", "brand", "samaritech-wordmark.png"));
    doc.image(logo, left, 46, { height: 26 });
  } catch {
    /* logo optional */
  }
  doc.fillColor(MUTED).font("Helvetica").fontSize(9).text("Samaritan Technical Services", left, 50, {
    width,
    align: "right",
  });

  doc.moveTo(left, 84).lineTo(right, 84).lineWidth(2).strokeColor(GOLD).stroke();

  doc.fillColor(INK).font("Helvetica-Bold").fontSize(20).text(meta.title, left, 100);
  doc.fillColor(TEAL).font("Helvetica-Bold").fontSize(12).text(meta.scopeLabel, left, doc.y + 2);
  doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(meta.forLine, { width });
  doc.fillColor(MUTED).fontSize(8).text(`Generated ${meta.generatedOn}`, { width });
  doc.moveDown(0.8);

  // --- KPI row ---
  const kpis: Array<[string, string]> = [
    ["Total spend", formatCents(report.grandTotal)],
    ["Sessions", String(report.sessionCount)],
    ["Unassigned", formatCents(report.unassignedTotal)],
  ];
  const kpiY = doc.y;
  const kpiW = width / 3;
  kpis.forEach(([label, value], i) => {
    const x = left + i * kpiW;
    doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(label.toUpperCase(), x, kpiY, { width: kpiW - 10 });
    doc.fillColor(i === 0 ? GOLD : INK).font("Helvetica-Bold").fontSize(16).text(value, x, kpiY + 11, { width: kpiW - 10 });
  });
  doc.y = kpiY + 40;
  doc.moveDown(0.5);

  // --- Breakdown tables ---
  const tables: Array<{ title: string; rows: ReportRow[] }> = [];
  if (meta.isTeam) tables.push({ title: "By person", rows: report.byPerson });
  tables.push({ title: "By project", rows: report.byJob });
  tables.push({ title: "By title", rows: report.byTitle });
  tables.push({ title: "By travel / meeting reason", rows: report.byReason });
  tables.push({ title: "By payment method", rows: report.byPaymentMethod });

  for (const t of tables) renderTable(doc, t.title, t.rows, left, width);

  // --- Footer ---
  doc.fillColor(MUTED).font("Helvetica").fontSize(8);
  doc.text("Samaritech — AmReceipts", left, doc.page.height - 40, { width, align: "center" });

  doc.end();
  return bufferPromise;
}

function renderTable(doc: PDFKit.PDFDocument, title: string, rows: ReportRow[], left: number, width: number) {
  // Page-break if not enough room for a heading + a row.
  if (doc.y > doc.page.height - 120) doc.addPage();

  doc.moveDown(0.5);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(title, left);
  doc.moveTo(left, doc.y + 2).lineTo(left + width, doc.y + 2).lineWidth(0.5).strokeColor(LINE).stroke();
  doc.moveDown(0.4);

  if (rows.length === 0) {
    doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(9).text("No data.", left);
    return;
  }

  for (const r of rows) {
    if (doc.y > doc.page.height - 60) doc.addPage();
    const y = doc.y;
    doc.fillColor(INK).font("Helvetica").fontSize(10).text(r.label, left, y, { width: width - 110 });
    const rowH = doc.y - y;
    doc
      .fillColor(INK)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text(formatCents(r.receiptTotal), left + width - 110, y, { width: 110, align: "right" });
    // Keep the cursor at the taller of the two columns.
    doc.y = y + Math.max(rowH, doc.currentLineHeight());
    doc.moveDown(0.15);
  }
}
