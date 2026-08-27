# M3 / ION API integration — configuration design

Status: **design + config schema only.** No ION calls are made yet.
Schema lives in `src/lib/m3/config.ts`.

## The problem

An AmReceipts expense has to become a posting in M3. That means resolving an
**accounting string** (AIT1–AIT7, where AIT1 is the GL account) plus a document
to carry it. Getting this wrong is expensive in a way that OCR errors are not:
a mis-posted voucher is a journal someone has to reverse.

## The core idea: two independent axes

Most expense integrations fail because they try to answer "which GL account?"
with a single lookup table. It is really two questions, and they have different
inputs:

| Axis | Question | Driven by | Decides |
|---|---|---|---|
| **How was it paid?** | reimburse or already-paid? | payment method | the **credit** side + document type |
| **What was it for?** | which cost bucket? | merchant, category, job, reason | the **debit** side (accounting string) |

Keeping these separate means adding a new company card doesn't touch a single
GL rule, and re-mapping the chart of accounts doesn't touch payment handling.

## Layer 1 — Connection (`M3ConnectionConfig`)

Fields lifted from a downloaded `.ionapi` file: gateway URL (`iu`), token URL
(`pu`/`ot`), tenant (`ti`), client id (`ci`).

Three deliberate choices:

- **Secrets are not in the database.** The existing `Integration.config` column
  stores a JSON blob that the admin API reads straight back to the browser
  (`src/app/api/admin/integrations/[key]/route.ts:30`). That is survivable for a
  stub; it is not survivable for a service account with ledger write access.
  `secretRef` names an env var holding `cs`/`saak`/`sask` instead.
- **Two flags to post, not one.** `dryRun: true` and `armed: false` by default.
  Enabling the integration can never by itself start writing vouchers.
- **The environment label is not trusted.** `prodHostAllowlist` comes from
  deployment, not the admin UI. A PRD-labelled config whose host isn't on it
  fails validation — and so does a DEV-labelled config pointing at a PRD host.

Retries are read-only. Writes go through the posting queue, which holds a
durable idempotency key per session; a blind retry on a timed-out voucher post
duplicates the voucher.

## Layer 2 — Binding (`M3CompanyBinding`, `M3EmployeeBinding`)

`User.company` is free text — far too loose to drive a ledger. Bind explicitly:
AmReceipts group (or exact company string) → `CONO` / `DIVI` / currency.
Unmapped users are **held**, never guessed.

`dimensionLabels` names AIT2–AIT7 the way that company uses them, so the rule
editor shows "Cost centre" rather than "AIT2".

Employees need a supplier number (to be paid through AP) or an employee number
(payroll reimbursement). At least one, enforced at config time.

## Layer 3a — Posting profiles (`M3PostingProfile`)

A discriminated union, so an AP profile cannot carry a credit account and a GL
profile cannot carry supplier settings:

- **`ap_invoice`** — supplier invoice batch. Keeps the AP subledger, payment run
  and VAT reclaim intact. The right default for money an employee is owed.
- **`gl_journal`** — journal voucher straight to the ledger. Right for company
  card spend, where the liability already sits on a card clearing account.

Selection is normally automatic from the payment method (AmReceipts already
captures brand + last4 on `PaymentMethod`, so a registry of company cards is
enough to split personal from corporate spend). A routing rule can override it
for cases like fuel on a fleet card.

## Layer 3b — Routing rules (`GlRoutingRule`)

Ordered rules, evaluated by `(precedence, id)` so the outcome never depends on
row order. Each matching rule merges a **partial** accounting string, and a
dimension already set by an earlier rule is never overwritten.

That merge model is the thing worth arguing about, so: it means a narrow rule
("Shell → account 7210") and a broad one ("Field Services group → cost centre
4400") compose without either restating the other. First-write-wins on each
dimension independently, not on the whole string.

Suggested precedence bands, spaced to leave room:

```
100  approver's session-level override
200  job / project derived
300  merchant specific
400  expense category
500  reason type (travel / meeting)
600  group or company default
900  catch-all
```

Conditions are a discriminated union by value type, so `hasJob gt 3` is not
expressible. Values may be literals or whole tokens (`{{job.number}}`) — mixed
forms like `J{{job.number}}` are rejected, since partial interpolation is where
silent mis-postings come from.

## What happens when nothing matches

Default is **`block`**, not "post to suspense". A routing gap is a config
defect; posting it anyway converts that defect into accounting cleanup someone
has to chase. `post_and_flag` is available with a `suspenseLimitCents` ceiling
for teams who prefer flow over strictness.

`RoutingResult` is a discriminated union on `status` — a caller cannot read
`.accounting` without first handling the blocked case.

## Known gaps before this can post

1. **`Receipt` has no expense category.** Merchant name alone is too weak: a
   supermarket receipt may be catering, materials or welfare. Needs a new field,
   inferred at OCR time with user override. This is the single biggest accuracy
   lever in the whole design.
2. **Master-data cache + validation.** Pull valid accounting identities and
   per-dimension rules from M3, cache them, and validate every rule against the
   cache in the admin console — so a typo'd account fails when it is typed, not
   at 02:00 in a batch.
3. **Posting queue + `M3Posting` table.** One row per session, unique on
   `sessionId`, holding status, idempotency key, returned voucher number, error
   and attempt count. Mirrors the existing `PendingLookup` pattern.
4. **Reversals.** Un-approving a posted session must raise a reversal voucher,
   never delete.
5. **Period/balance checks.** Posting date, open period, and balanced debit and
   credit validated before the call, not after the rejection.

## Verify against your installation

MI program names, FAM functions (`AP10`/`GL10`), voucher series, VAT codes and
dimension lengths are **installation-specific**. Confirm them in the M3 API
Repository for the target company/division before wiring the client. Nothing in
this schema hardcodes them; they are all configuration.

## Review trail

`src/lib/m3/config.ts` was reviewed twice by Codex (`codex exec`). Findings
folded in: no-idempotency-on-retry, untyped rule conditions, non-deterministic
precedence ties, ambiguous bindings, over-permissive suspense fallback,
incomplete profile refinements, empty-string dimension values, unvalidated
templates, declarative-only PRD arming, and missing currency/period on the
result. A `ZodEffects`-in-`discriminatedUnion` construction bug was caught
separately and confirmed fixed on the second pass.

**Not typechecked:** this sandbox has no Node toolchain and no `node_modules`,
so `tsc` has not been run against the file. Codex reviewed it as a substitute.
Run `npm install && npx tsc --noEmit` before relying on it.
