// Smoke test for the PDF receipt path.
//
//   npm run smoke:pdf
//
// Builds a realistic invoice with pdfkit - already a dependency - and runs it
// through the real extraction and parsing code. It covers the parts that only
// fail against an actual document: pdfjs text-run reconstruction, the
// wide-gap column handling, the long-date format, and the invoice-shaped
// amount heuristics.
//
// Not a substitute for trying a real supplier invoice, which is where layout
// surprises live. It is a floor: if this stops passing, something in the
// pipeline has regressed.

import PDFDocument from "pdfkit";
import { extractPdfText, parsePdfText } from "../src/lib/providers/pdf";

function buildInvoice(): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(16).text("ACME CLOUD SERVICES LTD", 50, 50);
    doc.fontSize(10).text("Invoice INV-2026-0042", 50, 80);
    doc.text("Date: 12 August 2026", 50, 95);

    // Two columns, to exercise the wide-gap column handling.
    doc.text("Description", 50, 140).text("Amount", 450, 140);
    doc.text("Professional plan", 50, 160).text("120.00", 450, 160);
    doc.text("Extra seats (3)", 50, 175).text("45.00", 450, 175);

    doc.text("Subtotal", 350, 220).text("165.00", 450, 220);
    doc.text("VAT (20%)", 350, 235).text("33.00", 450, 235);
    doc.text("Total", 350, 250).text("198.00", 450, 250);

    doc.text("Paid by VISA ****4242", 50, 300);
    doc.end();
  });
}

(async () => {
  const pdf = await buildInvoice();
  console.log(`generated invoice PDF: ${pdf.length} bytes`);

  const extracted = await extractPdfText(pdf);
  if (!extracted.ok) {
    console.log(`EXTRACTION FAILED: ${extracted.reason} - ${extracted.detail}`);
    process.exit(1);
  }
  console.log(`\n--- reconstructed lines (${extracted.pages} page) ---`);
  console.log(extracted.text);

  const parsed = parsePdfText(extracted.text);
  const money = (c: number | null) => (c === null ? "null" : (c / 100).toFixed(2));
  console.log("\n--- parsed ---");
  console.log(`merchant : ${parsed.merchant}`);
  console.log(`date     : ${parsed.purchaseDate}`);
  console.log(`subtotal : ${money(parsed.subtotal)}   (expect 165.00)`);
  console.log(`tax      : ${money(parsed.tax)}   (expect 33.00)`);
  console.log(`total    : ${money(parsed.total)}   (expect 198.00)`);
  console.log(`payment  : ${parsed.paymentRaw}`);

  const ok =
    parsed.total === 19800 && parsed.subtotal === 16500 &&
    parsed.tax === 3300 && parsed.purchaseDate === "2026-08-12";
  console.log(`\nRESULT: ${ok ? "PASS" : "MISMATCH"}`);
})();
