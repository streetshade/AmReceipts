# M3 / ION API integration — configuration design

> ## ⚠ This document's central design is contradicted by the M3 API repository
>
> Verified against the estate's API repository export (706 programs, 5,052
> transactions) and a read-only production extract, September 2026.
>
> **`APS450MI` is the only supplier-invoice route with a write API**, and
> neither `AddHead` (63 inputs) nor `AddLine` (37 inputs) accepts an account, a
> cost centre, or any of AIT1–AIT7. The GL coding is derived *inside M3* from
> FAM accounting rules on event `AP50` plus an invoice accounting template
> (`REGR`) on the supplier record. **The caller never chooses the accounting
> string.**
>
> That invalidates the "two axes" model below, the routing rule engine, the
> master-data catalogue and the per-line dimension storage — for this route.
> They are not wrong as M3 concepts; they are simply not what this API accepts.
>
> Three things get *easier*:
>
> - **Idempotency is native.** AP uniqueness is `SPYN`+`SUNO`+`SINO`+`INYR`, so
>   a re-posted claim with the same `SINO` A(24) is rejected rather than
>   duplicated. `CORI` A(36) exists expressly to correlate with a feeding system.
> - **The accounting date is a real field** — `ACDT` D(10) on `AddHead`.
> - **What posted can be read back**: `GLS200MI/LstVoucherLines(DIVI, YEA4,
>   VONO)`, with batch errors in `IBHE`/`IBLE` via `APS450MI/GetHead`.
>
> The real blocker is not code. `AP50`'s accounting rules are empty in most
> divisions, and whether per-line coding is expressible at all is untested. Both
> are finance configuration questions.
>
> **Resolution.** The routing engine stays — PSA Web does accept GL coding, so
> `routing.ts` and `masterData.ts` remain load-bearing for that path. The M3 path
> is now `aps450.ts`, which sends what APS450MI actually takes. The intent is to
> **complete M3's configuration as designed** — populate the `AP50` rules — not
> to contort the application around an install that was left unfinished.
>
> Everything below this box predates the discovery. The transport, queue, audit
> and safety work stands; read the GL routing sections as applying to PSA rather
> than to M3.

## The M3 route, as it actually is

`aps450.ts`. Sequence, with only one call that can leave a voucher behind:

```
LstInvBySupInv(SPYN, SUNO, SINO)   does this claim already exist?
AddHead(SUNO, IVDT, SINO, CORI, ACDT, …)   -> INBN
AddLine(INBN, RDTP, NLAM, VTA1, VTCD, CHGT) × N
AddAddInfo(INBN, PEXN, PEXI)       receipt references, if configured
ApproveInvoice(INBN)               only where the workflow expects it
APS455MI/ValidByBatchNo(INBN)      ← the only irreversible call
GetHead(INBN)                      IBHE / IBLE / VONO / YEA4
GLS200MI/LstVoucherLines(DIVI, YEA4, VONO)   what M3 actually coded
```

**Idempotency stops being ours to enforce.** AP uniqueness is
`SPYN`+`SUNO`+`SINO`+`INYR`, so a repeated claim is rejected by the ledger.
That is stronger than anything this application can do alone, and it is why the
reference must stay deterministic — the protection only works if a retry
presents the same `SINO` the first attempt used.

**The preflight does not answer "did it post?"** `AddHead` alone creates a
batch, so an attempt that died before validation leaves one behind. A batch
found under our `SINO` means *do not create a second header* and go and look —
which `GetHead` then settles from `IBHE`/`IBLE`/`VONO`. Treating any batch as a
completed posting would mark staged work as done.

**Amounts are checked before dispatch.** With `TXIN = 0` the header total is
gross and the lines are net, so nothing in the field mapping would catch a
claim whose parts disagree — it would simply post a wrong number.

### Still required before this can run in TST

None of it is code:

- `AP50` accounting rules — empty in most divisions. This is the blocker.
- Whether per-line coding is expressible at all, or only per claimant. One test
  claim with four lines differing by a single control field answers it.
- Batch type, line type, VAT codes, the receipt information category, and
  whether the approval step is part of the workflow.
- A service account scoped to the transactions actually called, and
  `AUTCHKMI/ChkAuthority` run against it — existence in the repository is not
  permission, and permission is not ION exposure.


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

## The posting queue and audit trail

`M3Posting` (one row per session) + `M3PostingLine` (what was sent) +
`M3PostingAttempt` (append-only, every attempt).

**Schema change required:** `npm run db:push`. This project has no
`prisma/migrations` directory — `db push` is its convention — so nothing will
work until the new tables exist.

### At-most-once, by construction

| Crash point | Result |
|---|---|
| After claim, before dispatch | Lease expires → `unknown`. Conservative: never retried |
| After `beginAttempt`, mid-call | `in_flight` attempt survives → `unknown` |
| M3 commits, worker dies before recording | `unknown`. Reconcile via `reference` |
| Stale worker returns late | Fenced out by `claimToken`; its result is appended as a late attempt |

Four mechanisms carry that:

- **Deterministic `reference`** (`AMR` + 17 chars, Crockford base32, derived
  from the session id) — unique, so a session cannot be enqueued twice, and
  searchable in M3 so an ambiguous posting can be resolved.
- **Write-ahead attempt log.** The attempt row is created *before* the call. An
  attempt left `in_flight` is not a gap in the record; it is evidence that a
  send began and never reported back.
- **`claimToken` fencing.** A worker must present the token minted at claim time
  to open an attempt, and the status check, token check and attempt-number
  increment are a single conditional update. A timestamp alone proves nothing
  about *who* holds the claim.
- **`unknown` is a one-way door.** Nothing that could conceivably have reached
  M3 is ever retried automatically. Only `not_delivered` (TLS never
  established), `auth_error` (no token, nothing dispatched) and
  `reconciled_absent` return to the queue.

A worker that returns after its lease expired does not throw and does not
overwrite: its result is appended as a new attempt, and a late `posted` with a
voucher number is allowed to resolve `unknown` → `posted`. That is the single
most valuable record in the trail.

### Posting is a sequence, not a call

An M3 voucher is a header, then a line per posting line, then a confirm. The
steps are **not equally dangerous**, and collapsing them into one opaque "write"
either over-reports ambiguity (every network blip becomes a manual
reconciliation) or under-reports it:

| Step | On an unknown outcome |
|---|---|
| head, line | A batch may be **staged**. No voucher exists. Find and clear it |
| confirm | A **voucher may exist**. Reconcile by reference before re-posting |

Each step is its own attempt row, carrying a `commits` flag, so the audit trail
says which of those two situations you are in. Only a committing call may settle
a posting as `posted` — enforced in `completeAttempt`, not just in the worker, so
a future caller cannot report a staged header as a voucher. A late reply is
judged the same way: a head arriving after its lease expired cannot resolve an
`unknown`.

The MI names and field mapping are **config**, in `voucherPoster`, discovered
with `MRS001MI/LstTransactions` and `LstFields`. This follows what
an existing internal M3 integration learned: its field mapping lives in config with a probe
script, because guessing produced "field not found" errors that looked like
outages. Per-step `constants` carry installation values (FAM function, voucher
series). `amountFormat` has no default — we store cents and M3 usually wants
major units, and getting it wrong is a 100x error in the ledger.

### Running the queue

`POST /api/m3/postings/drain`, by cron or by a signed-in admin:

```
*/15 * * * * curl -s -X POST -H "x-cron-secret: $CRON_SECRET" \
  https://receipts.example.com/api/m3/postings/drain >/dev/null
```

`CRON_SECRET` is **required** — no `AUTH_SECRET` fallback as the barcode-retry
job has. That fallback would make the session-signing secret a credential that
moves money. The comparison is constant-time.

Response codes are chosen so a monitor can tell the difference between a chosen
pause and a broken deployment: `200 {ran:false}` when the integration is
deliberately inactive or dry-run/unarmed, and **500** when someone enabled it
and the config is wrong.

The drain stops early on the first `ambiguous` or `auth_error`: whatever caused
it will likely affect the next posting too, and turning one reconciliation into
fifty helps nobody. Retries are budgeted per **sequence** (`tries`), not per MI
call, so a twenty-line voucher does not exhaust its budget on its first attempt.

### The audit trail

At `/postings`, scoped by role: a user sees their own, an approver their groups',
an admin **all rows** — not "all current users", so postings from a deleted
account stay visible, which is exactly when someone is auditing a leaver.

Filter by **person**, **job**, status, accounting-date range, and reference or
voucher number. Date filters run on `accountingDate` (a plain date string) not
`createdAt`, so there is no timezone to shift a period boundary.

Two CSV exports, because a posting has both lines and attempts and crossing them
would multiply into nonsense:

- **lines** — one row per voucher line: the accounting string as sent, receipt
  and routing-rule provenance, suspense flag.
- **attempts** — one row per attempt: outcome, timestamps, actor, MI
  program/transaction, HTTP status, per-attempt voucher, M3 message, and the
  parameters actually sent.

Both neutralise spreadsheet formula injection and mark truncation as a visible
final row, since a browser download never surfaces a response header.

Person and job are stored as **snapshots** on the posting, and the posting has
no foreign key to `ExpenseSession`. A cascade would delete the record of a
voucher that still exists in the ledger the moment someone tidied an expense.

### Not yet decided

`VoucherPoster` in `worker.ts` is an interface with no implementation. Which MI
program accepts the voucher, and whether a custom deduplicating transaction can
be built, are the open questions for the M3 team — guessing them would bake a
wrong answer into the one path that must not be wrong.

## The resolver

`routing.ts` is a pure function — no I/O, no clock. Routing decisions have to be
explainable months later, and a function whose output depends only on its
arguments can be replayed exactly as it ran.

- Rules ordered by `(precedence, id)`; id breaks ties so the outcome never
  depends on array or row order.
- Each matching rule merges a **partial** accounting string; first-write-wins
  **per dimension**, so a narrow rule and a broad one compose.
- A rule whose `{{token}}` has no value behind it contributes **nothing at all**
  — never a half-applied string. Tokens resolving to blank count as unresolved.
- The trace records rules that matched but could not resolve, so "did not apply"
  is distinguishable from "should have applied and couldn't".

**`matches` is bounded, not safe.** JavaScript offers no regex step budget, so a
pathological pattern can still be slow; the 120-character subject cap is what
keeps it survivable. `contains` / `starts_with` / `in` cover nearly every real
rule and cannot backtrack — prefer them.

## The builder

`build.ts` turns an approved session into a `PreparedPosting`. Money handling is
the part worth reviewing:

- **Receipt tax is apportioned pro-rata** across lines by the largest-remainder
  method, summing exactly to the receipt's tax. OCR gives one tax figure per
  receipt; dropping it would understate reclaimable VAT on every itemised
  receipt, and putting it all on one line would misstate that line.
- **Nothing is silently dropped.** Amounts the line items don't account for post
  as an "Unitemised balance"; a negative remainder is a "Discount / adjustment".
  A stated total ≤ 0 against positive lines is bad data and **blocks**.
- **Lines are grouped by accounting string**, keyed on JSON (dimension values
  may legally contain a separator) and including `viaSuspense`, so a flagged
  fallback line is never absorbed into a properly routed one.
- **Conflicting posting profiles block.** A session mixing company-card and
  personal spend needs two different documents with different credit sides, and
  one posting cannot be both. Guessing would reimburse an employee for spend
  already paid by the company. Unregistered company cards are warned about,
  since an unrecognised card is treated as personal and reimbursed.

`Receipt.expenseCategory` is now in the schema — the accuracy lever flagged
earlier. Populating it from OCR with user override is still to do; routing falls
through to broader rules while it is null.

## What the estate's own documentation established

Reviewed against internal M3 documentation for this estate. Company names,
hosts, database names and account codes are deliberately absent from this
repository; what follows is the design consequence only.

**There is already a substantial M3 write path**, and it is not in the systems
anyone points you at first. It runs from Salesforce Apex over the M3 REST APIs:
item master, order entry, customer master, plus a dozen custom list
transactions. Anything new should look like it, not invent a second idiom.

**The head → lines → confirm shape is the house pattern.** Order entry runs
`AddBatchHead` → `AddBatchLine` → `Confirm`. The multi-step poster in
`voucherPoster.ts` matches that, which is reassuring — but see the correction
below, because matching the shape is not the same as matching the semantics.

**Custom MI transactions here are declarative, over Information Categories** — a
saved view of a table with selection fields. Every observed example is a
`Lst_*` read. This corrects an earlier suggestion in this document: asking for a
custom *deduplicating write* transaction is not the cheap ask it appeared to be.
A custom *read* that answers "does a voucher with this reference exist?" is very
much in reach, and is what reconciliation actually needs.

**Five of the seven accounting dimensions are in use.** AIT1 carries the GL
accounts under a level 1/2/3 rollup; AIT2–AIT5 are in use with AIT5 holding
cost-element codes; AIT6 and AIT7 are unused. The chart export also carries a
blocked flag, validity dates, account group, balance/P&L/AR/AP flags, currency
and division — which is the master data the routing validation needs, and more
than this connector currently checks.

**Environment handling precedent:** matched PROD/TEST endpoint pairs, and a
static kill switch to suppress outbound M3 calls during bulk loads. The kill
switch is worth copying. The `FORCE_PRODUCTION` override alongside it is not: an
override that silently redirects test traffic to production is the failure this
connector's host allowlist exists to prevent.

## What the accounting dimensions actually mean

From the estate's own chart-of-accounts export. This was previously guesswork.

| Dim | Holds | Shape |
|---|---|---|
| AIT1 | GL account | 5-digit numeric, level 1/2/3 rollup |
| AIT2 | Facility / location | short codes that **repeat across sites** |
| AIT3 | Cost centre / territory / admin | mixed alphanumeric |
| AIT4 | Product / brand category | 3-digit numeric with rollup |
| AIT5 | Cost element / charge type | alphabetic (freight, duty, funds) |
| AIT6-7 | unused | — |

Two consequences worth stating plainly.

**A dimension value is meaningless without its company and division.** AIT2 codes
repeat across sites and are disambiguated only by description; several identities
are division-scoped. Validating a code without its scope validates nothing.

**AIT3 is the claimant-facing dimension for expenses**, which is what
`{{user.costCentre}}` is for. It was resolving to a hardcoded `null`, so every
rule using it silently contributed nothing. It now comes from an explicit
`User.m3CostCentre` — an assignment finance makes, not something inferred from
which group a person was put in for approvals.

Each identity also carries a blocked flag, valid-from/to dates, account group,
balance/P&L/AR/AP flags, currency and division. None of that is validated yet:
the length cap is still the only check, which is why a rule can name a blocked
account, or one outside its validity window on the posting date, and only find
out at posting time.

## Accounting date basis

A connector-agnostic setting, on both PSA and M3, because it is an accounting
policy and not an M3 detail:

- **approval** — the date the expense was approved. One date per session,
  always present.
- **receipt** — the date the money was actually spent. A voucher carries one
  date, so where receipts span days the **latest** is used: the earliest date
  by which every line had been incurred, and it avoids reaching back into a
  period that may be closed. A receipt dated after its own approval is a typo
  or an OCR misread and is ignored rather than booking into a future period.

Still open for finance: a session whose receipts genuinely straddle a period
boundary is booked entirely into the later period. Correct accounting would
split it. That is a policy decision, not a code one.

## What the cost-element material did and did not contribute

The estate's cost-element configuration is substantial — cost elements, costing
operators, PPS280 control fields, cost models. Almost none of it belongs here,
and saying why matters more than the parts that do.

It governs **landed cost on purchase orders**: how freight, duty and adjustment
funds are layered onto an item's cost. That is a different subsystem with
different semantics from posting an approved expense. Borrowing its machinery
would put purchase-order pricing logic inside an expense connector.

**One thing does cross over.** The accounting control objects it lists are
dimension values — the product categories on AIT4 and the charge types on AIT5.
Those are exactly what a routing rule needs to name, and exactly what the
connector could not previously validate.

So the mapping is a **master-data catalogue** (`masterData.ts`), not a costing
model. It mirrors an accounting-identity export — identity, dimension, division
scope, blocked, valid from/to, currency, postable — and is checked against the
date the voucher will be **booked under**, not today. An account valid when a
rule was written may be blocked, expired or not yet open in the period a
posting lands in.

Two deliberate refusals to fail open:

- **Stale data still validates.** An earlier version switched validation off
  once a snapshot aged out, so known blocked accounts began passing with only a
  warning. A month-old chart is usually still right, and certainly better than
  no checking; it validates and says it is stale.
- **A partial sync is not an authority on existence.** `completeFor` names the
  dimensions a snapshot covers fully. Without it a truncated import would
  reject every code it happened to miss.

The catalogue ships empty. A customer's chart of accounts is their data.

## The correction that matters most

**A successful `Confirm` may mean *submitted*, not *posted*.**

The estate's own documentation is explicit that order-entry failures are read
back *after* `Confirm`, through a separate error-list transaction, and that
"any new integration needs an equivalent, or failures are silent."

This connector has no equivalent. `completeAttempt` treats a committing step's
successful response as `posted`, which asserts more than the response supports.
It is careful about transport ambiguity and naive about business ambiguity —
a syntactically fine response to a call that was merely accepted for processing.

Before posting is enabled for real, the lifecycle has to be observed end to end:

1. Does the voucher MI's confirm mean durable success, or acceptance?
2. Is there an error-readback transaction, and what is it correlated by — batch
   number, job, user, company, timestamp? An unscoped list would attribute
   somebody else's failure to this posting.
3. Does an empty error list mean success, or "not processed yet"?
4. What cleans up a batch staged but never confirmed?

Until those are answered, `posted` should be read as "M3 accepted the call".

## Known gaps before this can post

1. **`Receipt` has no expense category.** Merchant name alone is too weak: a
   supermarket receipt may be catering, materials or welfare. Needs a new field,
   inferred at OCR time with user override. Biggest accuracy lever in the design.
2. **Master-data cache + validation** — via `MRS001MI` as above.
3. **Error readback after confirm** - the gap described above, and the reason
   posting should stay unarmed.
4. **Reversals.** Un-approving a posted session raises a reversal voucher,
   never a delete.
5. **Period/balance checks** before the call, not after the rejection.
6. **Dimension policy per company** - which of AIT1-7 are enabled, and their
   real lengths and code shapes. The connector models seven because M3 does;
   it does not yet stop a rule populating one this estate never uses.

## What the replica is not for

A SQL Server replica of M3 production is available and is what every reporting
extract uses. It is deliberately not wired into this connector, and the reasons
are stronger than preference: it is a *production* replica while this connector
supports DEV/TST/PRD, so a test integration would read live state; replica lag
makes "the reference is absent" unsafe evidence for retrying a financial write;
and judging writes by API responses while reconciling against an eventually
consistent database is a split brain. Reporting and human investigation are
legitimate uses. Deciding whether to re-post is not.

## Where the grid facts came from

The connection shape, the `maxrecs` behaviour, the error shapes and the
`MRS001MI` discovery route in this document were all read out of a working
in-house PHP integration that talks to a live M3 grid in this estate. They are
**observed**, not taken from documentation, which is why they are worth
trusting — and equally why they are worth re-checking, since they describe one
grid at one point in time.

That source lives in a private repository and is not linked from here. Nobody
reading this repo can verify these claims against it, so treat every specific
(ports, path prefixes, record caps, field names) as a starting hypothesis to
confirm against your own environment with `MRS001MI/LstTransactions` and
`LstFields`.

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
