// PDF receipt handling: read the text layer instead of OCR-ing a picture of it.
//
// A receipt from an online purchase is not an image. It carries a text layer
// with the exact characters, so rasterising it and guessing them back with OCR
// would be strictly worse than reading them. This path therefore produces
// BETTER data than any camera photo, and costs nothing per document.
//
// Two kinds of PDF arrive here:
//
//   text layer  Amazon, Uber, SaaS invoices. Extracted and parsed directly.
//   image only  someone scanned a paper receipt. There is nothing to extract,
//               and rasterising is deliberately out of scope - the caller falls
//               back to the existing manual-entry path.
//
// pdfjs is loaded lazily so the image path never pays for it.

import path from "node:path";
import { parseReceiptText, type ParsedReceipt } from "./ocr";
import { parseToCents } from "../money";

/**
 * Directory holding pdfjs's own copy of the 14 standard PDF fonts.
 *
 * Without this pdfjs warns and can mis-measure text laid out in Helvetica,
 * Times or Courier - which is most invoices - and text position is exactly
 * what the line reconstruction depends on. It resolves to a path INSIDE
 * node_modules, so this is a local file read, not the remote fetch the
 * hardening below is there to prevent.
 */
function standardFontsDir(): string | undefined {
  try {
    // createRequire rather than a bare require: this module is bundled for the
    // Next server runtime in production and run through tsx in scripts, and
    // only one of those has `require` in scope.
    const { createRequire } = require("node:module") as typeof import("node:module");
    const req = createRequire(__filename);
    return path.join(path.dirname(req.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep;
  } catch {
    // Falling back to undefined reproduces the old behaviour: a warning and
    // slightly less reliable metrics, rather than a failed extraction.
    return undefined;
  }
}

/** Below this many characters we assume there is no usable text layer. */
const MIN_USEFUL_TEXT = 40;

/** Pages read. Receipts and invoices are short; this bounds a hostile file. */
const MAX_PAGES = 10;

// A 12MB upload cap bounds bytes, not work: a small PDF can expand into an
// enormous object graph and pin the event loop. pdfjs runs in-process here, so
// these are the only brakes there are. They do not make a hostile file safe -
// they make it survivable. Real isolation would mean a worker or subprocess.
const PARSE_BUDGET_MS = 15_000;
const MAX_TEXT_ITEMS = 50_000;
const MAX_TEXT_CHARS = 500_000;

class PdfBudgetError extends Error {}

/**
 * Stop waiting once the DOCUMENT's deadline passes.
 *
 * The budget is per document, not per operation. An earlier version gave every
 * page its own 15 seconds, so a ten-page file could legitimately run for
 * minutes - which is not a budget at all.
 *
 * This abandons the wait; it does not cancel the work. pdfjs runs in-process
 * and its parsing is not interruptible, so a hostile file can still burn CPU
 * after we stop caring about the result. Bounding the wait keeps the REQUEST
 * from hanging; only a worker or subprocess would bound the work itself.
 */
async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new PdfBudgetError(`PDF parsing exceeded ${PARSE_BUDGET_MS}ms`);

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PdfBudgetError(`PDF parsing exceeded ${PARSE_BUDGET_MS}ms`)),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type PdfExtraction =
  | { ok: true; text: string; pages: number }
  // Not an error the user caused: a scanned PDF is a legitimate thing to upload.
  | { ok: false; reason: "no_text_layer" | "unreadable"; detail: string };

/**
 * Pull the text layer out of a PDF, preserving line structure.
 *
 * The line reconstruction is the part that matters. pdfjs hands back positioned
 * text runs, not lines, and the receipt parser is entirely line-based - it
 * scans bottom-up for totals and expects one item per line. Naively joining the
 * runs would produce a single smear of text that parses to nothing.
 */
export async function extractPdfText(bytes: Buffer): Promise<PdfExtraction> {
  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  try {
    // Legacy build: plain JS, no worker, no DOM, no native dependencies.
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (e) {
    return { ok: false, reason: "unreadable", detail: "pdfjs-dist is not installed" };
  }

  const deadline = Date.now() + PARSE_BUDGET_MS;
  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]> | null = null;
  let loadingTask: ReturnType<typeof pdfjs.getDocument> | null = null;

  try {
    loadingTask = pdfjs.getDocument({
        data: new Uint8Array(bytes),
        // Hardening. These files are uploaded by users, and pdfjs will happily
        // act on what a PDF asks for otherwise.
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: false,
        // A LOCAL directory under node_modules - never a URL. The document still
      // cannot pull in remote resources; it just gets the standard font
      // metrics it needs to be laid out correctly.
      standardFontDataUrl: standardFontsDir(),
    });
    // Held separately: if the load itself times out, `doc` is never assigned
    // and the task would otherwise be unreachable and undestroyable.
    doc = await beforeDeadline(loadingTask.promise, deadline);

    const pages = Math.min(doc.numPages, MAX_PAGES);
    const out: string[] = [];
    let items = 0;
    let chars = 0;

    for (let p = 1; p <= pages; p++) {
      const page = await beforeDeadline(doc.getPage(p), deadline);
      try {
        const content = await beforeDeadline(page.getTextContent(), deadline);

        // Cluster runs into visual lines by baseline. A tolerance rather than
        // Math.round: rounding splits one baseline whose runs drift by half a
        // unit, and merges two that happen to land either side of an integer.
        // Collected first, then clustered. Matching each run against whatever
        // rows exist so far - with a tolerance taken from the incoming run's
        // own height - made the result depend on iteration order and let one
        // large glyph absorb a neighbouring line.
        const runs: { x: number; y: number; width: number; height: number; text: string }[] = [];

        for (const item of content.items) {
          if (!("str" in item) || item.str === "") continue;
          if (++items > MAX_TEXT_ITEMS) throw new PdfBudgetError("PDF has too many text runs");
          chars += item.str.length;
          if (chars > MAX_TEXT_CHARS) throw new PdfBudgetError("PDF has too much text");

          const t = item.transform as number[];
          const [a, b, cc, d, x, y] = t;
          // Rotated or sheared text does not read left-to-right along x, so
          // including it would scramble the lines around it. Off-diagonal terms
          // catch 90-degree and sheared text; the positive-scale test catches
          // 180-degree text, which has b === c === 0 and would otherwise slip
          // through looking perfectly upright.
          if (Math.abs(b) > 0.01 || Math.abs(cc) > 0.01) continue;
          if (a <= 0 || d <= 0) continue;

          runs.push({ x, y, width: item.width ?? 0, height: Math.abs(d) || Math.abs(a) || 10, text: item.str });
        }

        // One tolerance for the whole page, from the median glyph height, so
        // clustering is deterministic rather than order-dependent.
        const heights = runs.map((r) => r.height).sort((h1, h2) => h1 - h2);
        const median = heights.length > 0 ? heights[Math.floor(heights.length / 2)] : 10;
        const tolerance = Math.max(median * 0.4, 1);

        const rows: { y: number; runs: typeof runs }[] = [];
        // Descending y groups top-down; each row keeps the baseline it was
        // opened with, so later runs cannot drag it.
        for (const run of [...runs].sort((r1, r2) => r2.y - r1.y)) {
          const row = rows[rows.length - 1];
          if (row && Math.abs(row.y - run.y) <= tolerance) row.runs.push(run);
          else rows.push({ y: run.y, runs: [run] });
        }

        // Rows are already in descending y - PDF coordinates start at the
        // BOTTOM of the page, so the top line has the largest y. Reversing this
        // would invert the document and break the parser's bottom-up scan.
        for (const row of rows) {
          const ordered = row.runs.sort((r1, r2) => r1.x - r2.x);
          let line = "";
          let prevEnd: number | null = null;
          for (const run of ordered) {
            // A wide horizontal gap marks a column boundary rather than a word
            // space. This is a HINT, not a guarantee: the marker survives into
            // the text so findInvoiceAmount can prefer the segment containing
            // its label, but a genuinely two-column document can still put an
            // unrelated figure beside a label.
            if (prevEnd !== null && run.x - prevEnd > 12) line += "   ";
            else if (line !== "" && !line.endsWith(" ")) line += " ";
            line += run.text;
            prevEnd = run.x + run.width;
          }
          const cleaned = line.replace(/[ \t]{4,}/g, "   ").trim();
          if (cleaned !== "") out.push(cleaned);
        }
      } finally {
        // Released even when a page throws - a hostile document is exactly the
        // case where holding onto page resources hurts most.
        page.cleanup();
      }
    }

    const text = out.join("\n");

    if (text.replace(/\s/g, "").length < MIN_USEFUL_TEXT) {
      return {
        ok: false,
        reason: "no_text_layer",
        detail: "This PDF appears to be a scan with no selectable text",
      };
    }
    return { ok: true, text, pages };
  } catch (e) {
    return {
      ok: false,
      reason: "unreadable",
      detail: e instanceof Error ? e.message : "Could not read the PDF",
    };
  } finally {
    // destroy() on the loading task tears down the document too, and works even
    // when the load never resolved.
    await (doc ? doc.destroy() : loadingTask?.destroy())?.catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Invoice-shaped parsing
// ---------------------------------------------------------------------------

// The shared parser is tuned for till receipts: money at the END of a line,
// totals near the bottom. A digital invoice is laid out differently - labels
// and values sit in columns, wording is "Order total" or "Amount charged", and
// the figure may not be last on its reconstructed line. Rather than rewrite
// heuristics that work well on photographed receipts, these run afterwards and
// only fill in what the shared parser left null.

const INVOICE_TOTAL_KEYS = [
  "order total", "grand total", "total charged", "amount charged", "amount paid",
  "total paid", "invoice total", "total due", "amount due", "total",
];
const INVOICE_SUBTOTAL_KEYS = ["subtotal", "sub-total", "items subtotal", "net total", "net amount"];
const INVOICE_TAX_KEYS = ["vat", "tax", "gst", "hst", "sales tax", "vat total"];

// Any money-looking figure, anywhere on the line - not anchored to the end.
// Both grouped ("1,234.56", "1 234,56") and plain ("1234.56") forms: an
// earlier version required a thousands separator and so missed every invoice
// that did not use one.
const MONEY_ANYWHERE = /-?[$£€]?\s?(?:\d{1,3}(?:[,.\s]\d{3})+|\d+)[.,]\d{2}\b/g;

/**
 * Parse a money string that may use either decimal convention.
 *
 * parseToCents strips everything but digits and ".", so "1.234,56" would come
 * out as 1.23456. The last separator followed by exactly two digits is the
 * decimal point; anything before it groups thousands.
 */
function moneyToCents(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.,-]/g, "");
  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  const decimalAt = Math.max(lastDot, lastComma);
  if (decimalAt === -1) return parseToCents(cleaned);

  const whole = cleaned.slice(0, decimalAt).replace(/[.,\s]/g, "");
  const fraction = cleaned.slice(decimalAt + 1);
  return parseToCents(`${whole}.${fraction}`);
}

/** Last monetary figure on a line, which is the value in a label/value row. */
function lastAmountOnLine(line: string): number | null {
  const matches = line.match(MONEY_ANYWHERE);
  if (!matches || matches.length === 0) return null;
  return moneyToCents(matches[matches.length - 1]);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `text` names one of `keys` as a standalone label, not inside a word.
 *
 * Written without a lookbehind: that is ES2018 syntax and TypeScript does not
 * downlevel regex, so under this project's ES2017 target it would compile
 * cleanly and then depend on the runtime to support it anyway.
 */
function namesKey(text: string, keys: string[]): boolean {
  return keys.some((k) => new RegExp(`(^|[^a-z-])${escapeRe(k)}([^a-z]|$)`, "i").test(text));
}

/** Column-ish segments of a reconstructed line, split on the wide-gap marker. */
function segments(line: string): string[] {
  const parts = line.split(/\s{3,}/).filter((p) => p.trim() !== "");
  return parts.length > 0 ? parts : [line];
}

function findInvoiceAmount(lines: string[], keys: string[], excludeKeys: string[] = []): number | null {
  // Bottom-up, like the receipt parser: summary rows sit below the detail.
  for (let i = lines.length - 1; i >= 0; i--) {
    // "Subtotal" and "Tax total" both contain "total". Word boundaries stop
    // the substring match, and the exclusion list stops a line that is plainly
    // about something else from being read as the grand total.
    if (excludeKeys.length > 0 && namesKey(lines[i], excludeKeys)) continue;
    if (!namesKey(lines[i], keys)) continue;

    // Prefer the figure in the same column segment as the label. On a genuine
    // two-column layout this stops "Total" on the left claiming an unrelated
    // amount from the right - though where a label and a stray figure share a
    // segment, nothing here can tell them apart.
    const parts = segments(lines[i]);
    const labelled = parts.find((p) => namesKey(p, keys));
    if (labelled) {
      const inSegment = lastAmountOnLine(labelled);
      if (inSegment !== null) return inSegment;
      // A label alone in its segment takes the next segment's figure, which is
      // exactly the ordinary label/value row.
      const idx = parts.indexOf(labelled);
      for (let k = idx + 1; k < parts.length; k++) {
        const near = lastAmountOnLine(parts[k]);
        if (near !== null) return near;
      }
    }

    const onSameLine = lastAmountOnLine(lines[i]);
    if (onSameLine !== null) return onSameLine;

    // Column layouts often put the label and its figure on adjacent lines once
    // the runs are flattened, so look just ahead before giving up.
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      const next = lastAmountOnLine(lines[j]);
      if (next !== null) return next;
    }
  }
  return null;
}

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const LONG_DATE = /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i;
const MONTH_FIRST = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i;
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

function findInvoiceDate(text: string): string | null {
  const iso = text.match(ISO_DATE);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const long = text.match(LONG_DATE);
  if (long) {
    const month = MONTHS.indexOf(long[2].toLowerCase()) + 1;
    return `${long[3]}-${String(month).padStart(2, "0")}-${long[1].padStart(2, "0")}`;
  }

  const monthFirst = text.match(MONTH_FIRST);
  if (monthFirst) {
    const month = MONTHS.indexOf(monthFirst[1].toLowerCase()) + 1;
    return `${monthFirst[3]}-${String(month).padStart(2, "0")}-${monthFirst[2].padStart(2, "0")}`;
  }
  return null;
}

/**
 * Parse extracted PDF text.
 *
 * Runs the shared receipt parser first, so anything that looks like a till
 * receipt keeps behaving exactly as it does today, then fills remaining gaps
 * with invoice-shaped heuristics. Additive by design: this cannot regress the
 * image path, because it only ever replaces a null.
 */
export function parsePdfText(text: string): ParsedReceipt {
  const parsed = parseReceiptText(text);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  if (parsed.total === null) {
    parsed.total = findInvoiceAmount(lines, INVOICE_TOTAL_KEYS, [
      ...INVOICE_SUBTOTAL_KEYS,
      // Every one of these contains "total" and means something else.
      "tax total",
      "vat total",
      "total tax",
      "total vat",
      "total gst",
      "total hst",
      "total discount",
      "total savings",
    ]);
  }
  if (parsed.subtotal === null) parsed.subtotal = findInvoiceAmount(lines, INVOICE_SUBTOTAL_KEYS);
  if (parsed.tax === null) parsed.tax = findInvoiceAmount(lines, INVOICE_TAX_KEYS);
  if (parsed.purchaseDate === null) parsed.purchaseDate = findInvoiceDate(text);

  // No arithmetic "correction" here on purpose. An earlier version rewrote a
  // total that equalled the subtotal as subtotal + tax, which double-counts
  // every VAT-inclusive invoice - where the total legitimately equals a
  // tax-inclusive subtotal. Reporting what the document says and letting the
  // user correct it beats silently inventing a different number.

  return parsed;
}
