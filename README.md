# AmReceipts

A phone-first web app for capturing, aggregating and reporting **job and travel expenditure**.
Each user has an account and creates **sessions**; within a session they scan **receipts**
(OCR'd into merchant, date, line items and payment method) and **product barcodes**
(looked up for a name, image and price). Scanned products are reconciled against receipt
line items, and each session is assigned to a **job number** or a **travel/meeting reason**
for reporting.

## Features

- **Accounts** — email/password auth with signed session cookies.
- **Sessions** — group receipts and scanned items for one trip/errand.
- **Receipt scanning** — capture from the phone camera; OCR extracts merchant, date,
  subtotal/tax/total, line items and payment method. Everything is user-verifiable/editable.
- **Payment methods** — the method read off a receipt (e.g. `VISA ****1234`) is reconciled
  onto the user's account automatically.
- **Barcode scanning** — live camera scanning (ZXing) or manual entry; barcodes are looked
  up in a seeded retail catalogue (or online), a product image is shown, and a quantity is
  solicited.
- **Reconciliation** — scanned products are fuzzily matched and linked to receipt line items
  (auto on scan, and manually adjustable).
- **Assignment & reporting** — assign a session to a job or a travel/meeting reason; the
  Reports page aggregates spend by job, by reason and by payment method.

## Tech stack

- **Next.js 14** (App Router) + TypeScript + Tailwind CSS
- **Prisma** ORM (SQLite by default; swap to Postgres for production)
- **Pluggable providers** so it runs with **zero API keys**:
  - OCR: `stub` (deterministic, offline) or `tesseract` (real on-device OCR)
  - Barcode: `local` (seeded DB) or `upcitemdb` (online lookup, caches into the local DB)

## Getting started

```bash
npm install
cp .env.example .env          # defaults work out of the box
npm run db:reset              # create schema + seed products and a demo user
npm run dev                   # http://localhost:3000
```

Sign in with the seeded demo account: **demo@amreceipts.app / password123**, or register a
new account.

> Camera access (receipt capture, live barcode scanning) requires HTTPS or `localhost`.
> On desktop without a camera, barcode entry falls back to a manual input.

## Switching to real OCR / online barcode lookup

In `.env`:

```env
OCR_PROVIDER="tesseract"      # real on-device OCR instead of the stub
BARCODE_PROVIDER="upcitemdb"  # online barcode lookup, falling back to the seeded DB
```

Providers are defined in `src/lib/providers/`. Add a Google Vision / AWS Textract OCR
backend or a different barcode source by implementing the `OcrProvider` / `BarcodeProvider`
interface and wiring it into the respective factory.

## Project layout

```
prisma/schema.prisma          Data model (User, PaymentMethod, Job, ExpenseSession,
                              Receipt, LineItem, Product, ScannedItem)
prisma/seed.ts                Seeded barcode catalogue + demo user
src/lib/providers/ocr.ts      OCR provider interface, receipt-text parser, stub + tesseract
src/lib/providers/barcode.ts  Barcode provider interface, local + upcitemdb
src/lib/matching.ts           Scanned-item ↔ line-item reconciliation
src/lib/reports.ts            Expenditure aggregation
src/app/api/...               REST API (auth, sessions, receipts, scan, barcodes, reports)
src/app/...                   UI (login, dashboard, session detail, reports, account)
```

## Notes / production hardening

- Receipt images are stored on local disk under `public/uploads` for dev — swap for object
  storage (S3/GCS) in production.
- The auth session is a signed stateless cookie; move to a session store + CSRF protection
  and rate limiting for production.
- Set a strong `AUTH_SECRET` and switch `DATABASE_URL` to Postgres.
