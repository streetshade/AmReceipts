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

**Corrected against a working client.** An existing internal M3 integration reads and writes a
live grid in this estate, and it does *not* go through the ION API multi-tenant
gateway. It calls `m3api-rest` directly on the grid and takes a bearer token
from Infor STS. There is no tenant segment, no `/M3/m3api-rest/v2` path, and no
tenant id anywhere:

```
baseUrl   https://<grid-host>:7443/infor/M3/m3api-rest
tokenUrl  https://<grid-host>:2443/InforIntSTS/connect/token
```

Credentials map straight out of a backend-service `.ionapi` file:
`ci` → clientId, `cs` → client secret, `saak` → username, `sask` → password,
`pu` + `ot` → tokenUrl. The grant is OAuth2 **password**, form-encoded in the
POST body.

Design choices:

- **Discriminated on `authMode`.** `oauth_password` requires `tokenUrl` and
  `clientId` at the type level; `basic` (test grids only) forbids them.
- **Secrets are not in the database.** `secretRef` names an env var holding an
  `M3Secrets` blob. The existing `Integration.config` column reads straight back
  to the browser (`src/app/api/admin/integrations/[key]/route.ts:30`) — fine for
  the PSA Web stub, not for a service account with ledger write access.
- **Two flags to post**, `dryRun: false` *and* `armed: true`.
- **Production hardening**: PRD must use `oauth_password` and may not disable
  TLS verification. Test grids run on self-signed certs, so `verifyTls: false`
  stays available below PRD.
- **The host allowlist is not a schema field.** It arrives from deployment and
  is checked by `checkProductionHost(config, allowlist)`. An allowlist an admin
  can edit next to the `baseUrl` attests nothing. Entries compare against
  `URL.host`, so they must include the port.
- **`maxrecs` must be positive.** In `m3api-rest` a `0` means *unbounded*, which
  makes the grid materialise an entire result set in one transaction — a
  documented cause of M3 memory spikes on this grid family. The grid also
  enforces its own ceiling (1000 observed) with **no offset to page past it**,
  so bulk reads partition by key, and a result of exactly `maxrecs` must be
  treated as possibly truncated.

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

## The hard part: idempotent GL posting

The reference client offers **no reusable idempotency pattern**, and that is not
an oversight — its only write is `PPS001MI/ConfirmLine`, which *sets* a delivery
date. Running it twice is harmless. A GL voucher *appends*; running it twice
creates two vouchers. So this problem has to be solved from scratch here, and it
is the riskiest part of the integration.

`m3api-rest` provides no HTTP idempotency-key guarantee, and the fact that its
mutating calls are exposed as `GET` does **not** make them repeatable.

Strategy, weakest to strongest:

1. **Deterministic reference in a searchable M3 field.** Derive a stable UUID
   from the session id and carry it in an external-document/reference field on
   the voucher.
2. **Query before any repost.** After a timeout, never retry blind: search M3
   for that reference and confirm company, division, year, voucher, amount,
   currency and line count before deciding.
3. **`UNKNOWN` is a terminal state, not a retryable one.** Absence of the
   reference immediately after a timeout is *not* proof the post didn't commit.
   An inconclusive reconciliation goes to manual review.
4. **Strongest: M3-side deduplication.** A custom MI transaction that accepts
   the UUID, records it in a uniquely-keyed table, and creates the voucher in
   the *same* M3 transaction — returning the existing voucher identity on
   repeat. Worth asking the M3 team for; nothing application-side is as safe.

## Operational behaviour to carry over

The reference client earned these the hard way; a TypeScript client that skips
them will behave differently from the proven one:

- `maxrecs` is sent **twice**: as the matrix parameter `;maxrecs=N` after the
  transaction segment *and* in the query string. Their grid ignores the
  query-string spelling and silently falls back to a default cap of 100 without
  the matrix form.
- One forced token refresh and one retry on `401`/`403`, then fail.
- Token cached to disk with a 60-second expiry margin, written `0600` via
  temp-file + rename. (No refresh locking — a thundering-herd guard is worth
  adding here.)
- Never follow redirects; a redirect could leak the bearer token to another host.
- Errors arrive in two shapes: `{"@type":"NOK","Message":...}` and
  `{"ErrorMessage":...}` — plus any HTTP ≥ 400. Normalise all three.
- Blank MI parameters are omitted so M3 applies its own defaults.
- Records come back as `MIRecord[].NameValue[]` `Name`/`Value` pairs; flatten.
- Whitelist `[A-Za-z0-9_]` on program and transaction names.

## Discovering the real MI names

My earlier note said "verify MI program names against your installation" without
saying how. The reference client answers it: **`MRS001MI/LstTransactions`**
(with `MINM=<PROGRAM>`) lists the transactions a program actually exposes on
*this* grid, and **`MRS001MI/LstFields`** lists their field names. There is also
a REST `{baseUrl}/metadata/{PROGRAM}` resource as a fallback, though not every
grid routes it. `scripts/probe_api.php` in that repo is a working example.

This closes the master-data gap properly: the admin console can validate every
routing rule against what the grid really offers, rather than against a guess.

## Known gaps before this can post

1. **`Receipt` has no expense category.** Merchant name alone is too weak: a
   supermarket receipt may be catering, materials or welfare. Needs a new field,
   inferred at OCR time with user override. Biggest accuracy lever in the design.
2. **Master-data cache + validation** — via `MRS001MI` as above.
3. **Posting queue + `M3Posting` table.** One row per session, unique on
   `sessionId`, holding status (including `UNKNOWN`), the deterministic
   reference, returned voucher number, error and attempt count.
4. **Reversals.** Un-approving a posted session raises a reversal voucher,
   never a delete.
5. **Period/balance checks** before the call, not after the rejection.

## Still to confirm with the M3 team

- Which MI program actually accepts the voucher on this grid, and whether it
  exposes a field that can carry a unique external reference.
- Whether a custom dedup MI transaction is acceptable to build.
- FAM functions, voucher series, VAT codes and dimension lengths for the target
  company/division. Nothing in the schema hardcodes these.
- Whether employee reimbursement should go through AP at all, or through payroll.

## Review trail

`src/lib/m3/config.ts` was reviewed three times by Codex (`codex exec`), the
third time with that internal M3 client on hand for comparison.
Findings folded in across those passes: no-idempotency-on-retry, untyped rule
conditions, non-deterministic precedence ties, ambiguous bindings,
over-permissive suspense fallback, incomplete profile refinements, empty-string
dimension values, unvalidated templates, declarative-only PRD arming, missing
currency/period on the result, a missing `defaultCono`, an implicit secret
contract, a runtime-only OAuth field contract (now discriminated), and a host
allowlist that was not genuinely out of band. A `ZodEffects`-in-
`discriminatedUnion` construction bug was caught outside Codex and confirmed
fixed on the second pass.

**Not typechecked:** this sandbox has no Node toolchain and no `node_modules`,
so `tsc` has never been run against the file. Codex reviewed it as a substitute
and judged it compile-clean. Run `npm install && npx tsc --noEmit` before
relying on it.
