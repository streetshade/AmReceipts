import crypto from "crypto";
import { parseToCents } from "../money";

export interface ParsedLineItem {
  description: string;
  quantity: number;
  amount: number; // cents
}

export interface ParsedReceipt {
  merchant: string | null;
  purchaseDate: string | null; // ISO date
  paymentRaw: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  lineItems: ParsedLineItem[];
  rawText: string;
}

export interface OcrProvider {
  readonly name: string;
  process(image: Buffer, mime: string): Promise<ParsedReceipt>;
}

// --- Shared parser: turn raw receipt text into structured fields --------------

const CARD_BRANDS = ["VISA", "MASTERCARD", "AMEX", "AMERICAN EXPRESS", "DISCOVER", "DEBIT"];
const TOTAL_KEYS = ["grand total", "total", "amount due", "balance due"];
const SUBTOTAL_KEYS = ["subtotal", "sub total", "sub-total"];
const TAX_KEYS = ["tax", "hst", "gst", "vat", "sales tax"];
const SKIP_LINE = /(subtotal|sub total|sub-total|total|tax|hst|gst|vat|change|cash|balance|tender|visa|mastercard|amex|debit|discover|approval|auth|card|account|thank you|www\.|receipt|store|tel|phone)/i;

const MONEY_AT_END = /(-?\$?\s?\d{1,4}(?:[.,]\d{2}))\s*$/;
const QTY_PREFIX = /^(\d{1,3})\s*[xX@]\s*/;

/** Extract a labelled monetary amount, scanning bottom-up (totals sit near the end). */
function findAmountByKeys(lines: string[], keys: string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const lower = lines[i].toLowerCase();
    if (keys.some((k) => lower.includes(k))) {
      const m = lines[i].match(MONEY_AT_END);
      if (m) return parseToCents(m[1]);
    }
  }
  return null;
}

function findMerchant(lines: string[]): string | null {
  // Heuristic: first non-empty line that looks like a name (letters, not a total/date).
  for (const line of lines.slice(0, 5)) {
    const t = line.trim();
    if (t.length < 3) continue;
    if (/\d{2}[:/.-]\d{2}/.test(t)) continue; // date/time
    if (MONEY_AT_END.test(t)) continue;
    if (/[a-zA-Z]{3,}/.test(t)) return t.replace(/\s{2,}/g, " ");
  }
  return null;
}

function findDate(text: string): string | null {
  // Match common formats: 01/23/2024, 2024-01-23, Jan 23 2024.
  const patterns = [
    /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/, // ISO-ish
    /(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/, // US/EU
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    let y: number, mo: number, d: number;
    if (m[1].length === 4) {
      y = +m[1];
      mo = +m[2];
      d = +m[3];
    } else {
      mo = +m[1];
      d = +m[2];
      y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (!Number.isNaN(dt.getTime())) return dt.toISOString();
  }
  return null;
}

function findPayment(lines: string[]): string | null {
  for (const line of lines) {
    const upper = line.toUpperCase();
    const brand = CARD_BRANDS.find((b) => upper.includes(b));
    if (brand) {
      const last4 = line.match(/(?:\*+|x+|#)?\s*(\d{4})\s*$/);
      const norm = brand === "AMERICAN EXPRESS" ? "AMEX" : brand;
      return last4 ? `${norm} ****${last4[1]}` : norm;
    }
    if (/\bcash\b/i.test(line)) return "CASH";
  }
  return null;
}

function findLineItems(lines: string[]): ParsedLineItem[] {
  const items: ParsedLineItem[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.length < 3 || SKIP_LINE.test(t)) continue;
    const m = t.match(MONEY_AT_END);
    if (!m) continue;
    const amount = parseToCents(m[1]);
    if (amount == null || amount <= 0) continue;
    let desc = t.slice(0, m.index).trim().replace(/[.\s]+$/, "");
    let quantity = 1;
    const q = desc.match(QTY_PREFIX);
    if (q) {
      quantity = Math.max(1, +q[1]);
      desc = desc.replace(QTY_PREFIX, "").trim();
    }
    if (desc.length < 2) continue;
    items.push({ description: desc, quantity, amount });
  }
  return items;
}

export function parseReceiptText(rawText: string): ParsedReceipt {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  return {
    merchant: findMerchant(lines),
    purchaseDate: findDate(rawText),
    paymentRaw: findPayment(lines),
    subtotal: findAmountByKeys(lines, SUBTOTAL_KEYS),
    tax: findAmountByKeys(lines, TAX_KEYS),
    total: findAmountByKeys(lines, TOTAL_KEYS),
    lineItems: findLineItems(lines),
    rawText,
  };
}

// --- Stub provider: deterministic, offline, no keys ---------------------------

const STUB_MERCHANTS = [
  { name: "Home Depot #4021", pay: "VISA ****1234" },
  { name: "Shell Gas Station", pay: "MASTERCARD ****5678" },
  { name: "Office Depot", pay: "AMEX ****9001" },
  { name: "Marriott Downtown", pay: "VISA ****1234" },
  { name: "Corner Deli", pay: "CASH" },
];

const STUB_ITEMS = [
  { description: "Duct Tape 1.88in x 60yd", amount: 899 },
  { description: "USB-C Charging Cable 6ft", amount: 1299 },
  { description: "Duracell AA Batteries 4pk", amount: 699 },
  { description: "Bottled Water 24pk", amount: 399 },
  { description: "Coca-Cola Classic 20oz", amount: 219 },
  { description: "Nature Valley Granola Bars 12ct", amount: 549 },
  { description: "Sharpie Fine Point Black", amount: 179 },
  { description: "Parking - 2 hours", amount: 600 },
];

/**
 * Produces a plausible, *deterministic* receipt derived from the image bytes,
 * so the full pipeline (verify header, edit line items, reconcile payment,
 * link barcodes) is exercisable without any OCR dependency or API key.
 */
class StubOcrProvider implements OcrProvider {
  readonly name = "stub";

  async process(image: Buffer): Promise<ParsedReceipt> {
    const hash = crypto.createHash("sha256").update(image).digest();
    const pick = <T,>(arr: T[], salt: number) => arr[hash[salt % hash.length] % arr.length];

    const merchant = pick(STUB_MERCHANTS, 0);
    const count = 2 + (hash[1] % 3); // 2-4 items
    const chosen: ParsedLineItem[] = [];
    for (let i = 0; i < count; i++) {
      const item = pick(STUB_ITEMS, 3 + i);
      const quantity = 1 + (hash[10 + i] % 2);
      chosen.push({ description: item.description, quantity, amount: item.amount * quantity });
    }

    const subtotal = chosen.reduce((s, i) => s + i.amount, 0);
    const tax = Math.round(subtotal * 0.08);
    const total = subtotal + tax;
    const daysAgo = hash[2] % 30;
    const date = new Date(Date.now() - daysAgo * 86_400_000);

    const rawText = [
      merchant.name,
      date.toISOString().slice(0, 10),
      ...chosen.map((i) => `${i.quantity}x ${i.description}   $${(i.amount / 100).toFixed(2)}`),
      `Subtotal   $${(subtotal / 100).toFixed(2)}`,
      `Tax   $${(tax / 100).toFixed(2)}`,
      `Total   $${(total / 100).toFixed(2)}`,
      merchant.pay,
    ].join("\n");

    return {
      merchant: merchant.name,
      purchaseDate: date.toISOString(),
      paymentRaw: merchant.pay,
      subtotal,
      tax,
      total,
      lineItems: chosen,
      rawText,
    };
  }
}

// --- Tesseract provider: real on-device OCR -----------------------------------

class TesseractOcrProvider implements OcrProvider {
  readonly name = "tesseract";

  async process(image: Buffer): Promise<ParsedReceipt> {
    // Lazy import so the stub path never loads the heavy WASM bundle.
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("eng");
    try {
      const { data } = await worker.recognize(image);
      return parseReceiptText(data.text || "");
    } finally {
      await worker.terminate();
    }
  }
}

// --- Google Cloud Vision provider: real cloud OCR -----------------------------

// The Vision client is expensive to construct and safe to reuse across requests.
let visionClient: import("@google-cloud/vision").ImageAnnotatorClient | null = null;

async function getVisionClient() {
  if (visionClient) return visionClient;
  const vision = await import("@google-cloud/vision");
  // Auth resolution order:
  //   1. GOOGLE_VISION_KEY_FILE  -> explicit service-account JSON path
  //   2. GOOGLE_APPLICATION_CREDENTIALS -> picked up automatically by the SDK
  //   3. GCE/GKE metadata / gcloud ADC
  const keyFilename = process.env.GOOGLE_VISION_KEY_FILE || undefined;
  visionClient = new vision.ImageAnnotatorClient(keyFilename ? { keyFilename } : {});
  return visionClient;
}

class GoogleVisionOcrProvider implements OcrProvider {
  readonly name = "google-vision";

  async process(image: Buffer): Promise<ParsedReceipt> {
    const client = await getVisionClient();
    // DOCUMENT_TEXT_DETECTION handles dense, structured text (receipts) best.
    const [result] = await client.documentTextDetection({ image: { content: image } });
    if (result.error?.message) throw new Error(`Vision API: ${result.error.message}`);
    const text = result.fullTextAnnotation?.text || result.textAnnotations?.[0]?.description || "";
    return parseReceiptText(text);
  }
}

// --- Google Document AI provider: structured receipt/expense parsing ----------
//
// Unlike the OCR-text providers above, Document AI's Expense/Invoice processor
// returns *typed entities* (supplier, date, total, tax, line items), so this
// provider maps them straight to ParsedReceipt and skips parseReceiptText.
// Requires DOCAI_PROCESSOR_ID (+ DOCAI_LOCATION, default "us") and the same
// service-account credentials as Vision (GOOGLE_APPLICATION_CREDENTIALS).

let docaiClient: import("@google-cloud/documentai").DocumentProcessorServiceClient | null = null;

async function getDocAiClient(location: string) {
  if (docaiClient) return docaiClient;
  const docai = await import("@google-cloud/documentai");
  // Document AI is region-scoped; the endpoint must match the processor's region.
  docaiClient = new docai.DocumentProcessorServiceClient({
    apiEndpoint: `${location}-documentai.googleapis.com`,
  });
  return docaiClient;
}

/** Money entity -> integer cents (prefers the normalized moneyValue). */
function entMoneyCents(e: any): number | null {
  const m = e?.normalizedValue?.moneyValue;
  if (m && (m.units != null || m.nanos != null)) {
    return Math.round(Number(m.units ?? 0) * 100 + Number(m.nanos ?? 0) / 1e7);
  }
  return parseToCents(e?.normalizedValue?.text ?? e?.mentionText ?? null);
}

/** Date entity -> ISO string (prefers the normalized dateValue). */
function entDateISO(e: any): string | null {
  const d = e?.normalizedValue?.dateValue;
  if (d?.year && d?.month && d?.day) {
    const dt = new Date(Date.UTC(d.year, d.month - 1, d.day));
    if (!Number.isNaN(dt.getTime())) return dt.toISOString();
  }
  const t = e?.normalizedValue?.text ?? e?.mentionText;
  if (t) {
    const dt = new Date(t);
    if (!Number.isNaN(dt.getTime())) return dt.toISOString();
  }
  return null;
}

function entText(e: any): string | null {
  return ((e?.normalizedValue?.text ?? e?.mentionText) || null) as string | null;
}

/** Map a Document AI Expense/Invoice document to our ParsedReceipt shape. */
function mapExpenseDocument(doc: any): ParsedReceipt {
  const entities: any[] = doc?.entities ?? [];
  const first = (type: string) => entities.find((e) => e?.type === type);

  const dateEnt = first("receipt_date") ?? first("purchase_date") ?? first("invoice_date");
  const payType = entText(first("payment_type"));
  const last4 = entText(first("credit_card_last_four_digits"));
  let paymentRaw: string | null = null;
  if (payType || last4) {
    const brand = (payType ?? "CARD").toUpperCase().replace(/_/g, " ").trim();
    paymentRaw = last4 ? `${brand} ****${last4}` : brand;
  }

  const lineItems: ParsedLineItem[] = [];
  for (const e of entities) {
    if (e?.type !== "line_item") continue;
    const props: any[] = e.properties ?? [];
    const pFirst = (t: string) => props.find((p) => p?.type === t);
    const description = (entText(pFirst("line_item/description")) ?? entText(e) ?? "").trim();
    const amount = entMoneyCents(pFirst("line_item/amount"));
    const qtyText = entText(pFirst("line_item/quantity"));
    const quantity = qtyText ? Math.max(1, Math.round(Number(qtyText.replace(/[^0-9.]/g, "")) || 1)) : 1;
    if (description && amount != null) {
      lineItems.push({ description: description.slice(0, 200), quantity, amount });
    }
  }

  return {
    merchant: entText(first("supplier_name")),
    purchaseDate: dateEnt ? entDateISO(dateEnt) : null,
    paymentRaw,
    subtotal: entMoneyCents(first("net_amount")),
    tax: entMoneyCents(first("total_tax_amount")),
    total: entMoneyCents(first("total_amount")),
    lineItems,
    rawText: doc?.text ?? "",
  };
}

class DocumentAiOcrProvider implements OcrProvider {
  readonly name = "documentai";

  async process(image: Buffer, mime: string): Promise<ParsedReceipt> {
    const location = (process.env.DOCAI_LOCATION || "us").toLowerCase();
    const processorId = process.env.DOCAI_PROCESSOR_ID;
    if (!processorId) throw new Error("DOCAI_PROCESSOR_ID is not set");

    const client = await getDocAiClient(location);
    const projectId = process.env.DOCAI_PROJECT_ID || (await client.getProjectId());
    const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;

    const [result] = await client.processDocument({
      name,
      rawDocument: { content: image, mimeType: mime || "image/jpeg" },
    } as any);
    if (!result?.document) throw new Error("Document AI returned no document");
    return mapExpenseDocument(result.document);
  }
}

export function getOcrProvider(): OcrProvider {
  const which = (process.env.OCR_PROVIDER || "stub").toLowerCase();
  switch (which) {
    case "tesseract":
      return new TesseractOcrProvider();
    case "google":
    case "google-vision":
    case "googlevision":
      return new GoogleVisionOcrProvider();
    case "documentai":
    case "document-ai":
    case "docai":
      return new DocumentAiOcrProvider();
    case "stub":
    default:
      return new StubOcrProvider();
  }
}
