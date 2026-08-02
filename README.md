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
  solicited. An online lookup happens **only the first time** a barcode is seen: the product
  info **and the image bytes** are then stored locally, so every repeat use is served entirely
  from the app with no external calls.
- **Reconciliation** — scanned products are fuzzily matched and linked to receipt line items
  (auto on scan, and manually adjustable).
- **Assignment & reporting** — assign a session to a job or a travel/meeting reason; the
  Reports page aggregates spend by job, by reason and by payment method.

## Branding

The interface is themed for **Samaritech (Samaritan Technical Services)**: a dark
desaturated-teal ground with a vivid cyan primary accent and a warm gold secondary
accent (palette taken from the reference dashboard image), the Samaritech logo, and
the Arial/Helvetica brand type (10px is the smallest brand size). Logo assets live in
`public/brand/`; the palette and type are defined in `tailwind.config.ts` and
`src/app/globals.css`.

## Deferred barcode lookups (rate limiting)

The upcitemdb trial endpoint allows ~100 lookups/day. When that limit is hit, a lookup
**fails gracefully** — the item is still recorded by barcode — and the barcode is queued
in `PendingLookup` for a retry **24 hours later**, when the quota resets. On a successful
retry the product is cached and any items scanned before it resolved are backfilled with
the product details automatically.

Retries run opportunistically on scans/lookups, and can also be driven on a schedule via
`POST /api/maintenance/retry-lookups` (guarded by `CRON_SECRET`) — see
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the cron setup.

## Tech stack

- **Next.js 14** (App Router) + TypeScript + Tailwind CSS
- **Prisma** ORM (SQLite by default; swap to Postgres for production)
- **Pluggable providers** so it runs with **zero API keys** in dev, and swaps to
  production services with an env var:
  - OCR: `stub` (deterministic, offline), `tesseract` (on-device OCR),
    `google-vision` (Vision OCR text → heuristic field parser), or `documentai`
    (Google Document AI Expense parser → structured fields, best receipt accuracy)
  - Barcode: `local` (seeded DB) or `upcitemdb` (online lookup, caches into the local DB)

The seeded barcode catalogue is weighted toward **Home Depot and other hardware /
building-supply vendors** (power tools, hand tools, fasteners, paint, electrical,
plumbing, adhesives, building materials, safety, lighting, garden, storage).

## Getting started

```bash
npm install
cp .env.example .env          # defaults work out of the box
npm run db:reset              # create schema + seed products and a demo user
npm run dev                   # http://localhost:3000
```

Seeded accounts (all `password123`) — one per role:

| Email | Role | Notes |
|---|---|---|
| `admin@amreceipts.app` | Administrator | manages all accounts, groups, integrations |
| `approver@amreceipts.app` | Approver | oversees the **Field Team** group |
| `demo@amreceipts.app` | Basic user | member of Field Team |

Or register a new account (defaults to the basic-user role).

> Camera access (receipt capture, live barcode scanning) requires HTTPS or `localhost`.
> On desktop without a camera, barcode entry falls back to a manual input.

## Roles, groups & approvals

Three access levels, enforced in every API route (`requireRole`) and page:

- **Basic user** — captures sessions, submits them for approval, sees a **self report**
  (spend by project, by title, by reason, by payment method).
- **Approver** — everything a user can do, plus an **Approvals** queue to approve/reject
  sessions submitted by members of the **groups** they oversee, and a **team report**
  (spend by person / title / project across those they oversee).
- **Admin** — administers **all accounts** (role, group, active state, account record),
  manages **groups** (name + assigned approver), and configures **integrations**.

Each account carries a full record: name, email, **company** and **title** (self-editable
on the Account page; also administrable by an admin). Approval flow on a session:
`draft → submitted → approved | rejected` (a rejected session can be resubmitted).

## Integrations (admin stub)

Admins have a **Business system integrations** page (`/admin/integrations`) — a
configuration placeholder. The first example, **PSA Web**, stores base URL / API key /
company ID / sync flag and an enabled toggle. It is a stub: config is persisted, but no
external sync is performed yet.

## Switching to real OCR / online barcode lookup

In `.env`:

```env
# On-device OCR (no external service):
OCR_PROVIDER="tesseract"

# Google Cloud Vision OCR (raw text -> heuristic field parser):
OCR_PROVIDER="google-vision"
GOOGLE_APPLICATION_CREDENTIALS="/etc/amreceipts/gcp-vision.json"  # service-account key

# Google Document AI Expense parser (structured fields -> best receipt accuracy):
OCR_PROVIDER="documentai"
GOOGLE_APPLICATION_CREDENTIALS="/etc/amreceipts/gcp-vision.json"  # same service-account key
DOCAI_LOCATION="us"                # us | eu (must match the processor's region)
DOCAI_PROCESSOR_ID="xxxxxxxxxxxx"  # from the Document AI console

# Online barcode lookup, falling back to (and caching into) the seeded DB:
BARCODE_PROVIDER="upcitemdb"
```

**Vision vs Document AI:** `google-vision` returns raw OCR text that a built-in
regex parser turns into fields — cheaper, but heuristic. `documentai` uses a trained
Expense/Invoice processor that returns structured fields (merchant, date, total,
tax, line items) directly — more accurate on real-world receipts, at a higher
per-page cost. Both use the same service-account credentials; Document AI also needs
a processor created in the console (its region + ID above).

Providers are defined in `src/lib/providers/`. To add another backend (AWS Textract,
a different barcode source, …) implement the `OcrProvider` / `BarcodeProvider`
interface and wire it into the respective factory.

## Deploying on Debian

- **AWS EC2 (clean Debian), start to finish** — [`docs/AWS-DEPLOYMENT.md`](docs/AWS-DEPLOYMENT.md),
  including EC2 instance-size recommendations, PostgreSQL, TLS, backups and cost.
- **Generic Debian server** — the walkthrough below.

A full generic walkthrough (nginx + TLS, systemd, PostgreSQL, Google Vision) is in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), with ready-to-use config under `deploy/`:

- `deploy/amreceipts.service` — systemd unit
- `deploy/nginx-amreceipts.conf` — reverse proxy (TLS, upload size, static caching)
- `deploy/amreceipts.env.example` — production environment file

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

- Uploaded files live under `public/uploads` (receipt images in `public/uploads/`, cached
  product images in `public/uploads/products/`). They're served by nginx in production and by
  a built-in `/uploads/[...path]` route otherwise — swap for object storage (S3/GCS) at scale.
- The auth session is a signed stateless cookie; move to a session store + CSRF protection
  and rate limiting for production.
- Set a strong `AUTH_SECRET` and switch `DATABASE_URL` to Postgres.
