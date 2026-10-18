# Testing infrastructure — design

Status: BUILT — PR A (the `database` CI job) and PR B (the built app, `verify:leads` in CI, the Playwright journeys) landed 2026-10-05/06; the harness-mode rule, the local-only gates and the CI guard 2026-10-08 (sections at the end). Written 2026-10-05 as a design; the as-built sections are dated.
Reference: docs/testing-reference.md (Lokl's proven patterns).

## What this covers

Two additions to The Reserve's CI, designed together because they share
the local Supabase stack:

1. **The `database` CI job** — starts the local stack, resets from
   migrations, and runs the verify:\* harnesses against it. Closes the
   board's "dedicated CI Supabase project" item. No secrets needed.
2. **The Playwright e2e suite** — numbered journey tests that run against
   the local stack with a built app. Requires a running server; follows
   the database job.

Built in two separate PRs:

- PR A: the `database` job (closes the board item immediately)
- PR B: the Playwright suite (larger, depends on PR A)

## The two findings from Lokl that shape this design

### 1. The auth cookie prefix (the non-obvious silent failure)

Nuxt's Supabase module fixes the auth cookie name at BUILD time from the
Supabase project URL the build environment pointed at. When a laptop build
runs against the local stack, the cookie name is keyed to the hosted
project's URL — so every page reads as signed out against the local stack,
even with valid credentials, because the browser has a cookie named for
the hosted project and the app is looking for one named for the local one.

The fix (one line in the app-start script): set the auth cookie prefix
from the local stack's URL before starting the app. Lokl does this; The
Reserve must do the same. Without it, every Playwright test that visits
an authenticated page will see the unauthenticated state, silently. This
is the first thing to get right and the last thing anyone would guess.

The line in the start script (scripts/ci-start-app.mjs, as built):

```js
NUXT_PUBLIC_SUPABASE_COOKIE_PREFIX: `sb-${new URL(url).hostname.split(".")[0]}-auth-token`
```

The same derivation `@supabase/ssr` uses, so the cookie the test writes and
the cookie the app looks for have one name.

### 2. The ledger and the money journey cleanup problem

Lokl deletes bookings in test cleanup under a replica session role
because its schema forbids deleting them in real use. The Reserve's
ledger is append-only — by the absence of update/delete policies, which
the service role bypasses; there is NO explicit REVOKE, and until
docs/design/ledger-integrity-design.md lands its update/delete block
(2026-10-07 finding) a service-role cleanup script succeeds. The same
cleanup approach would exercise exactly the forbidden path, which is
both wrong (undermining the integrity guarantee) and misleading (a test
that cleans up by breaking the rule it's testing).

**Decision required before the first money journey** — SUPERSEDED
2026-10-08 by "The money journeys" design at the end of this document:
neither option survived the ledger becoming append-only for every role
with `restrict` keys. What was built is a test organisation per run,
removed whole on the direct connection in replica mode. The two options
stay below as the record of the choice as it was framed.

Option A — **Tagged rows, left in place** (the C2 baseline pattern):
Test transactions are tagged with a test run ID and never deleted. The
test verifies the row exists and has the right values; cleanup is a
periodic manual or cron-driven sweep by tag. This is what the C2 ledger
baseline already does and it's honest — the ledger is append-only in
tests as in production.

Option B — **A dedicated test organisation**: Every test run creates a
fresh org, runs all its money journeys inside it, and the entire org is
deleted at the end (cascading through every table including the ledger).
The ledger rows go with the org. This is the cleanest isolation but
requires an org-creation fixture and trusts the cascade rather than the
explicit cleanup.

**My recommendation: Option B (test org) for the Playwright suite,
Option A (tagged rows) for the verify:\* harnesses.** The harnesses
already use tagged rows (PREVIEW-6MO, PHASE4-TEST, etc.) and that
pattern is proven. The Playwright suite runs full journeys that cross
many tables; a test org with cascade deletion is cleaner than tagging
dozens of rows across a dozen tables. The org delete is one statement.
Confirm before building.

## PR A — the `database` CI job

### What it does

```yaml
database:
  name: database (local stack + harnesses)
  runs-on: ubuntu-latest
  timeout-minutes: 20
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version-file: .nvmrc
        cache: npm
    - name: Install Supabase CLI
      run: npm install -g supabase@latest
    - name: Start local stack
      run: supabase start --ignore-health-check \
        -x realtime -x storage-api -x imgproxy \
        -x inbucket -x postgrest -x gotrue
      working-directory: .
    - name: Reset database from migrations
      run: supabase db reset --local
    - name: Install dependencies
      run: npm ci
    - name: Run verify harnesses
      run: npm run verify:forms && npm run verify:leads && npm run verify:ask
      env:
        SUPABASE_LOCAL: true
```

The excluded services (`-x` flags) match Lokl's list: everything The
Reserve doesn't use (storage, realtime for CI, imgproxy, inbucket). Keep
realtime excluded unless the harnesses specifically test realtime behavior
(they don't — they test DB state directly).

### The localhost guard

Every verify:\* harness must refuse to run if its database URL resolves
to anything other than localhost. The guard:

```javascript
const url = new URL(process.env.SUPABASE_URL || "");
if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
  console.error("SAFETY: refusing to run against a non-local database.");
  process.exit(1);
}
```

This is the one thing Lokl does that The Reserve's harnesses currently
lack. It must be added to all four verify:\* scripts before the CI job
runs them, so a misconfigured runner can never touch the hosted project.
Same principle as the fail-closed config: refuse rather than degrade.

### The `supabase status` env assembly

The harnesses currently read `.env` from the repo root. In CI, the
local stack's credentials come from `supabase status -o env`. The
harnesses need to pick up the local stack's service role key and URL
rather than the hosted project's. Two ways:

Option A — The CI step exports `supabase status -o env` into the
runner's environment before the harness step. The harnesses read
`process.env.SUPABASE_URL` and `process.env.SUPABASE_SERVICE_ROLE_KEY`
directly (they already do, since that's how `.env` values reach them).
The local values override the `.env` values because environment variables
take precedence.

Option B — The harnesses detect `SUPABASE_LOCAL=true` and call
`supabase status -o env` themselves.

**Recommendation: Option A.** The CI step sets the env; the harnesses
stay unchanged. Separation of concerns: the workflow knows how to talk
to the local stack; the harnesses just need the right values.

### The `turbo.json` pipeline

The database job runs outside Turbo (it needs the local stack, which is
not a Turbo concern). The CI workflow adds a parallel job alongside the
existing `check` job. The existing `check` job is unchanged:

```yaml
jobs:
  check: # existing — typecheck + tests + lint
    ...
  database: # new — local stack + harnesses
    ...
```

Both jobs run in parallel. The database job does not depend on `check`.
A failing harness does not block a typecheck-passing PR (and vice versa).

## PR B — the Playwright e2e suite

AS BUILT 2026-10-06 (stages 1 and 2). Three things in the first draft of
this section followed the design rather than the reference and were
corrected while building: the suite runs against the BUILT app, not the
dev server; sign-in goes through `@supabase/ssr` with an in-memory cookie
jar, never a hand-built cookie; and the browser runs in a zone that is
NOT the spa's. Each is explained where it lands below.

### Stage 1 — build and start the app for tests

- `RESERVE_BUILD_CHECK=1` in `apps/reserve/nuxt.config.ts` builds into
  `.nuxt-check` and `.output-check` with a separate Vite cache, so a test
  build never clobbers a running dev server's `.nuxt`. Both gitignored.
  `npm run build:check` (scripts/build-check.mjs) runs it. The first
  build:check found a real production-build bug: a `v-model` on a cast
  expression in the public form field, which the dev server tolerated and
  the build rejected. Fixed with typed writable computeds.
- `npm run app:start` (scripts/ci-start-app.mjs) starts the built server
  with `NODE_ENV=production` on **3300** (not 3000, and not Lokl's
  3100/3101/3200/3201), assembles its env from the local stack through
  `scripts/_env.mjs`, refuses any non-local URL, sets
  `NUXT_PUBLIC_SUPABASE_COOKIE_PREFIX` from the local URL (the finding in
  section 1 above), looks up the seeded organisation for lead capture,
  records the pid, polls the port, and writes the values a harness must
  share with the app to `node_modules/.cache/ci-app.env`.
  `npm run app:stop` stops it. `supabase/config.toml` lists the 3300 URLs
  among the auth redirects.
- The `e2e` CI job: stack, reset from migrations, export, build, start,
  `verify:leads` against the running app (it joins CI here), then
  Playwright; traces and screenshots uploaded on failure; the app stopped
  in `always()`. One of the four required checks on `main`
  (`e2e (built app + Playwright)`; docs/deployment.md, "Branching and
  releases").

### Stage 2 — structure

```
e2e/
├── playwright.config.ts
├── package.json             — `"type": "module"`: the suite loads as ES modules
├── tsconfig.json            — `tsc -p e2e` runs in the typecheck + tests job
├── support/
│   ├── env.ts               — the local stack, through _env.mjs's guard
│   ├── auth.ts              — signIn(context, email, password) via @supabase/ssr
│   ├── data.ts              — TestData: run id, tracked ids, cleanup in order
│   └── fixtures.ts          — test.extend with `data`, cleanup in finally
└── journeys/
    ├── 01-auth.spec.ts
    ├── 02-clients.spec.ts   — stage 3 (built)
    └── 03-scheduler.spec.ts — stage 3 (built; the proof the timezone seam stays closed)
```

At the repo root, matching Lokl. Nothing test-only lives in the app.

### The `playwright.config.ts`

`testDir: ./journeys`, `fullyParallel: false`, `workers: 1` (one stack,
one app), `retries: 0`, trace `retain-on-failure`, screenshot
`only-on-failure`, Chromium at desktop size only until a staging site
exists over HTTPS, `baseURL` from `E2E_BASE_URL` (3300). No `webServer`
block: the app is started by `app:start` before the run, built, the way
CI runs it.

**The suite is ES modules** (`e2e/package.json`, `"type": "module"`).
`support/env.ts` imports `scripts/_env.mjs`, which reads `import.meta.url`
for the repo root. Loaded as CommonJS, Playwright's transform compiles
that `.mjs` to CommonJS and `import.meta` cannot be expressed there:
"Cannot use 'import.meta' outside a module", every spec file failing to
load, "No tests found". It passed on one laptop Node (22.12) and failed
on CI's (22.22) — found by the first CI run, reproduced locally with the
CI version, fixed by loading the suite natively.

**`timezoneId: "America/Los_Angeles"`, on purpose.** The first draft said
Eastern, the spa's own zone. That would let a page that formats by the
browser clock pass. The browser runs in a zone that is NOT the location's,
and every time a journey asserts is the LOCATION's, so the recorded
scheduler seam (the grid positions by the browser clock) fails here
rather than hides.

### The auth helper

`signIn(context, email, password)` runs the password sign-in in the test
code through `createServerClient` from `@supabase/ssr` — the library the
app reads its cookies with — into an in-memory jar, waits for the library
to write, and adds those cookies to the browser context for `localhost`
with `SameSite=Lax`. No cookie is hand-built: if the library changes its
name or format, both sides change together and a mismatch shows as a
login page, never as a quiet pass. Journey 1 signs in through the real
login form AND through the helper and must land on the same signed-in
dashboard, which is the proof the two agree. Switching user mid-test is
`context.clearCookies()` then `signIn` again.

### The TestData fixture

`TestData.create()` finds the seeded organisation; `staffMember(label,
role)` is the first builder: an auth user with a password
(`auth.admin.createUser`, confirmed), a `staff` row in that organisation,
and a `staff_roles` row for one of the four seeded roles. `client()` and
`trackClient()` serve journey 2; `locationInZone()`, `service()` and
`hours()` serve journey 3 (the seeded location moved into a zone for the
run and put back; a bookable service with no intake and no room; the
same weekly hours every day). Every email and display name carries the
run id. `cleanup()` deletes in dependency order (communications, appointments,
clients, services, role rows, staff, auth users, then the location's
zone), runs every step even when one fails, and THROWS at the end if any
did — a row that cannot be removed fails the run instead of accumulating.
That rule came from a run: a super_admin fixture was refused by the
last-super-admin trigger (a fresh stack has no other), nothing reported
it, and the row then counted as "another super admin" for every later
run. No journey uses super_admin now.

### Journey 1 — auth (built)

A front-desk member signs in through the login page and lands on the
dashboard; a signed-out visit to `/clients` is sent to `/login`; an
admin sees the Financials nav entry and a provider, who lacks
`financials.view_summary`, does not (while still seeing Clients, which
they hold, so the absence is not vacuous). Controls are found by role and
accessible name.

### Journey 2 — clients (built)

The front desk creates a client through the sheet, finds them through
the search box in the list the page re-read after saving, opens the
profile through the row's View link, changes the communication channel
from Email to SMS in the preferences section, and reloads: the change
must be there after a fresh load, which is the only proof it was saved
and not merely drawn. The value before the edit is asserted too, so the
change is a change.

### Journey 3 — scheduler (built)

The seeded location is put in America/New_York for the run; the browser
is in America/Los_Angeles; a provider has hours 10:00–11:00 local, one
60-minute slot; the front desk opens the dialog, picks client, service
and staff, asks for times, books the one slot, and finds the card in the
provider's lane. Every time the journey asserts is the LOCATION's,
`10:00 AM`.

On its first run it exposed the recorded two-timezone seam — the dialog
offered `7:00 AM`:

```
- "10:00 AM",
+ "7:00 AM",
```

The slot labels and the card labels formatted in the browser clock, and
the grid positioned cards and built its day range from it. The fix
(2026-10-06) moved all of that onto one shared module,
`shared/time/zone.ts`, which the slots route imports too, so the
route's instant and the grid's pixel come from the same conversion in
the same zone; `tests/shared/zone.test.ts` round-trips both directions
across zones that differ from the runner's. The journey's assertions
were not changed; it passed once the page agreed with the route, and it
is what keeps the seam closed. The rest of the app followed on
2026-10-07: every business-time surface formats through
`shared/time/format.ts` in the location's zone, date-only values go from
the key to words without a Date, and `tests/guards/browserClock.test.ts`
fails the suite on any browser-clock call in `app/` outside the
messaging thread. `e2e/journeys/09-dashboard.spec.ts` is the proof: a
12:30 AM New York appointment on the location's day in a Los Angeles
browser, and a date of birth reading as stored.

### The money journey decision (confirm before building)

Superseded 2026-10-08: see "The money journeys" at the end. Journeys 10
to 17 write ledger rows in an organisation of their own.

### The test-timeout contention note

The `check` job runs vitest with no server; the `e2e` job runs the built
app on its own VM. No contention in CI. Locally, the Nuxt-environment
vitest files time out when a dev server is BUILDING beside them; the
built app on 3300 does not build, so `test:e2e` and `npm test` can run
side by side.

## Build order

**PR A — the database job (close the board item):**

1. Add the localhost guard to all four verify:\* harnesses
2. Add the `database` job to `.github/workflows/ci.yml`
3. Test locally: `supabase start`, `supabase db reset --local`,
   `supabase status -o env`, then run the harnesses with those env vars
4. Push, confirm the new CI job goes green alongside the existing `check`

**PR B — the Playwright suite (its own PR after PR A), as built:**

1. Stage 1: build-check mode, `app:start`/`app:stop`, the 3300 redirect
   URLs, the `e2e` CI job with `verify:leads` against the running app.
2. Stage 2: `e2e/` skeleton, `tsc -p e2e` in the check job, journey 1
   (auth) passing locally and in CI — the cookie proof every later
   journey depends on.
3. Stage 3: journey 2 (clients) built and in the suite; journey 3
   (scheduler) exposed the timezone seam on its first run — never
   `fixme`, never assert in the browser's zone — and joined the suite with
   the fix, as its proof.
4. Money journeys wait for the cleanup decision and their own PR.

## Decisions to confirm before building

1. ~~**Money journey cleanup**: test org (cascade) or tagged rows?~~
   Decided 2026-10-08: a test organisation per run, removed on the direct
   connection (no cascade exists any more) — "The money journeys".
2. **Which journeys in PR B, first slice?** Recommendation: auth,
   clients, and scheduler — no money, no ledger, proves the auth cookie
   fix and the TestData fixture before the harder journeys.
3. **`verify:messages` harness**: still on the punch list — add it to
   PR A alongside the localhost guard, since the CI stack enables it.

## As built, 2026-10-08: harness modes, the CI guard, the comparison

**Which harness runs where.** Every harness reads its credentials
through `scripts/_env.mjs`: the local stack under `SUPABASE_LOCAL=true`
(from `supabase status -o env`), else hosted from `apps/reserve/.env`.
CI runs all of them against the local stack. By hand:

| Harness | Hosted | Why |
| --- | --- | --- |
| `verify:policies` | read-only, yes | reads `pg_policies` only |
| `verify:ask` | yes | reads as `ask_readonly` |
| `verify:presets` | read-only cases only | the ledger fixture is local |
| `verify:forms`, `verify:messages`, `verify:tables`, `verify:leads` | skip line, exit 0 | they create staff and grant roles, which writes append-only audit rows |
| `verify:ledger`, `verify:audit`, `seed:tables`, `bench:tables`, `app:start` | refuse, exit 1 | they write ledger or audit rows, or start the app for the journeys |
| `verify:build-secrets` | anywhere; no database | builds with sentinel secrets and proves none is baked, then starts the built server blank and checks its startup report (docs/deployment.md, "Secrets at runtime") |

The refusing scripts share one gate, `requireLocalStack()` in
`scripts/_env.mjs`; the skipping ones share `localOnlyOrSkip()`. Those
two calls are the MARKER `apps/reserve/tests/guards/ciLocalOnly.test.ts`
reads: it derives the local-only scripts from the source, maps each to
its npm scripts, parses `.github/workflows/ci.yml`, and fails the unit
suite on any step that runs one without `SUPABASE_LOCAL=true` in its
step, job or workflow env — naming the job, step and harness. It was
written after a workflow edit split `verify:ledger` from its env block
and the harness refused in CI (run 37727683375), and it found one more
step on its first run. Proven non-vacuous against a fixture copy of the
workflow with that bug reintroduced.

**The schema comparison (2026-10-08).** `npm run schema:compare` dumps
the public schema's shape on hosted (TBLS_DSN) and on the local stack
(DB_URL) and prints every difference, exit 1 on any: extensions, tables
and views by column, constraints, indexes, policies, triggers (with
their enabled state), functions by full definition, views by definition,
options and owner, grants, function grants, default privileges, cron
jobs and publication tables. It runs before a hosted push (the
differences must be exactly the migration's) and after it (zero). Until
2026-10-08 it lived outside the repo and did not compare view
definitions or options; see policy-sweep-design.md for what that
excluded.

**Hosted runs never write into an append-only table (2026-10-08).**
`audit_log` and the ledger refuse UPDATE and DELETE for every role, and
creating staff or granting a role writes an audit row through the
staff_roles trigger, so a hosted harness run that did either would leave
rows it could never remove — which is exactly what the 30 orphan audit
rows found by the policy-sweep inventory were. `verify-tables`,
`verify-forms`, `verify-leads` and `verify-messages` therefore run their
session cases on the local stack only and print a `skip` line on
hosted; `verify-presets` and `verify-policies` keep their read-only
hosted cases; `verify-ledger` and `verify-audit` are local only. Local
cleanup removes a run's audit rows, what its staff wrote and what the
trigger wrote about them, through `scripts/_cleanup.mjs` on the direct
postgres connection with replica mode behind the localhost guard; the
e2e support uses the same helper.
The gate is `localOnlyOrSkip(url)` in `scripts/_env.mjs`, and it has
three outcomes, not two: with SUPABASE_LOCAL it runs; on a hosted stack
it skips and exits 0; on a stack whose URL is local WITHOUT the flag it
refuses with exit 1. The third exists because CI run 37727683375 hit it
the day the gates landed: the e2e job's verify:leads step had no
SUPABASE_LOCAL, every one of its 72 cases skipped, and the step passed.
A workflow step that forgets the flag now fails instead.

`verify:ledger` (2026-10-08, docs/design/ledger-integrity-design.md) is
LOCAL ONLY and needs the built app up (`npm run build:check && npm run
app:start`): it writes ledger rows through `write_ledger_transaction`
and through the checkout and refund routes with a real session, proves a
rejected write wrote nothing, and removes its rows through the direct
postgres connection, never the API.

## The money journeys — design (stop 1, 2026-10-08; nothing built)

STATUS: DESIGN for review. No journey, builder or workflow change exists
yet. Inputs: the as-built sections above, the money-journey cleanup
decision (§2, "Decision required"), `docs/testing-reference.md` §1
(Lokl's Stripe sandbox gating), `docs/design/ledger-integrity-design.md`,
`e2e/support/*`, and the checkout, refund, financials and cancel code as
it stands on main at a6f99af.

### 1. Cleanup: a test organisation per run, removed on the direct connection

The original Option B — a test organisation deleted at the end, its
ledger rows cascading — no longer works, for two reasons that are now
structural: the ledger refuses UPDATE and DELETE for every role
(`append_only_block()`), so no API delete of a test transaction can
succeed; and every key out of the ledger is `on delete restrict`, so the
organisation, its location, clients, staff, products and gift cards
cannot be deleted while a transaction points at them. Option A (tagged
rows left in place) is what the harnesses do and it is honest, but a
Playwright money journey crosses a dozen tables and would leave real
sales in the seeded organisation that every later journey's `/financials`
would count.

**The replacement, and it holds:** each money journey creates its OWN
organisation, and cleanup removes everything carrying that organisation's
id through the direct `postgres` connection with
`session_replication_role = replica`, behind `requireLocalStack()`, in
the shared cleanup helper (`scripts/_cleanup.mjs` gains
`removeTestOrganisation(dsn, orgId)`). Replica mode turns off every
trigger — the append-only block AND the foreign-key checks, which are
internal triggers — so the deletes need no API path and no cascade; the
ledger's rule is not exercised by the test's own cleanup, which is the
point of doing it on the direct connection and nowhere else.

What it needs:

- **A provisioned organisation, the way migration 1 leaves one.** An
  `organizations` row (name, timezone), one `locations` row (name,
  timezone, `tax_rate_bps`), and the four system roles with their
  permission matrix COPIED from the seeded organisation's roles by name
  (`roles` → `role_permissions`), so a test front desk holds exactly what
  the live front desk holds and a change to the matrix is tested, not
  bypassed. Staff, clients, services, products and gift cards are then
  the existing builders with `organization_id` pointed at the run's
  organisation. Everything a journey writes — through the UI, the routes,
  `write_ledger_transaction`, the triggers — carries that id: the
  transaction header from the checkout route's `orgId`, the lines and
  payments from the function's `p_organization_id`, the audit rows from
  the writers, gift cards minted at checkout from the route, cancellation
  tokens from the appointment.
- **Isolation falls out of RLS.** The journey's staff belong to the new
  organisation, so `current_org_id()` is its id, every policy scopes to it,
  and the booking, slots and checkout routes' `.limit(1)` location reads
  run under the user client, so they find the run's location, not the
  seeded one. No other journey can see the run's rows, and the run sees
  none of theirs: `/financials` in a fresh organisation shows exactly the
  journey's sale, which makes the figure assertions exact rather than
  "increased by". The existing journeys keep using the seeded
  organisation (they read it; `locationInZone` moves its location) — only
  the money journeys provision one. The `data` fixture grows a
  `TestData.createOrganisation()` path; `TestData.create()` is unchanged.
- **Dependency order in the helper**, one transaction, replica mode: the
  child tables with no `organization_id` first, by join to the run's
  parents — `appointment_services`, `availability_rules`,
  `availability_exceptions`, `client_notes`, `staff_roles`,
  `staff_locations`, `service_staff`, `service_resource_requirements`,
  `resources` (via `resource_types`), `notifications`,
  `conversation_participants` and `messages` (via `conversations`),
  `role_permissions` (via `roles`) — then every table that carries the
  column, by id: `payments`, `transaction_items`, `transactions`,
  `cancellation_tokens`, `appointments`, `client_payment_methods`,
  `card_consents`, `gift_cards`, `communications_sent`, `audit_log`,
  `clients`, `products`, `services`, `service_categories`,
  `resource_types`, `conversations`, `staff_invites`, `staff`,
  `locations`, `roles`, and the rest of the list in
  `information_schema` (campaigns, forms, leads, ask_queries — empty for a
  money journey, deleted anyway), then `organizations`. After the commit:
  the auth users through the admin API, and an assertion that EVERY
  org-scoped table holds zero rows for that id and that no child row
  references a parent that is gone — because with foreign-key checks off,
  a table left off the list leaves orphans silently, and the convention
  says to measure that signal. A failure here fails the journey, as the
  existing `cleanup()` does.
- **The helper, not the fixture, owns the list** — the harnesses'
  two-organisation cases (`verify-tables`, `verify-presets`,
  `verify-audit`, `verify-messages`) each delete their test organisation
  by hand today and could move onto the same helper later; not in this
  work.
- **Stripe side effects are not in Postgres**: a Stripe customer created
  for a saved-card journey is deleted at cleanup through the Stripe API
  (test mode), logged rather than failed if it cannot be, so the sandbox
  does not fill with customers.

### 2. The journeys and what each proves

Numbering continues from 09. Each journey runs in its own organisation
with its own front desk (`front_desk` holds `pos.checkout`, `clients.view`,
`products.view`, `gift_cards.view` and `transactions.view`, but not
`financials.view_summary`; the owner used for `/financials` is
`admin`). Money is asserted both on the page and in the database through
the service-role client, by the run's organisation id, so a page that
looks right over wrong rows fails.

- **10 — checkout, card terminal.** A product sale rung up on `/checkout`:
  pick the client, add the product (price and tax known to the test),
  take the card at the terminal — the tender the page offers; the page
  has no cash tender today, though the ledger's `payments.method` allows
  one — Charge. Proves: the "Checkout complete" toast with the total; the
  transaction row on `/transactions` with that total; on `/financials`
  for the month, revenue, tax and the transaction count equal to what was
  charged — one sale, exact figures, because the organisation holds
  nothing else. In the database: one transaction with the page's
  idempotency key, its lines and payment balanced (the trigger would have
  refused otherwise), the `pos.checkout` audit row carrying the
  organisation.
- **11 — gift card: sell, then pay with it.** Sell a $50 card at
  checkout (cash); read its code from the receipt line / the gift cards
  list (the route appends the code to the line's name). Second sale: a
  $30 product, apply the card by code on `/checkout`, Charge. Proves: the
  "Gift card applied" toast with the balance; the card's balance is
  exactly $20 after (page and `gift_cards` row); the sale's payment row
  is `gift_card` for $30. Then a third cart over the remaining balance
  with the card applied for its remaining $20: the page caps what it
  applies at the balance it looked up, so the over-balance case is a
  STALE balance — another sale spends the card between Apply and Charge
  (the service role moves the balance to $5 in the test) — and the route
  refuses with "Gift card balance is $5.00" (422): NOTHING is written, no
  transaction, the balance still $5 (the trigger's overdraft check is the
  backstop; the route's 422 is what the person sees).
- **12 — retail stock.** A product with stock 5, quantity 2 sold (the
  same product added twice makes one line of quantity 2). Proves:
  `/products` shows 3 after, `products.stock_quantity` is 3; the stock
  trigger fired once for the sale (not again on a retried Charge —
  journey 14 covers the retry; this one asserts the plain path).
- **13 — refund, already refunded, View refund.** Refund journey 10's
  shape of sale from `/transactions`. Proves: the mirror row appears
  (negative total, "refund" badge, pointing at the original); the
  original shows "Refunded"; `/financials` nets to zero revenue for the
  month. Then refund the same original again: the "Already refunded"
  toast with the amount, and its **"View refund" action** is clicked —
  the page navigates to `/transactions?open=<refund id>` and the refund's
  detail dialog is open. That click has never been driven in a browser.
  In the database: one refund per original (the partial unique index),
  the stock RESTORED — read from the code, not assumed:
  `apply_product_sale` (pos_refund_fix) adds a negative line's quantity
  back, so a refund of two puts the stock from 3 to 5 — and the
  `pos.refund` audit row.
- **14 — a lost response.** Press Charge with the request intercepted:
  Playwright `page.route('**/api/checkout')` lets the request reach the
  server (`route.fetch()`), then aborts the reply (`route.abort()`), so the
  server committed and the browser saw a network failure. The page shows
  its error toast; Charge again, un-intercepted, with the SAME key (the
  page keeps it until a 409). Proves: the second Charge answers
  "Checkout complete" and EXACTLY ONE transaction exists for the key in
  the organisation, with one set of lines and one payment; the stock
  dropped once; one `pos.checkout` audit row. This is the retry path of
  `write_ledger_transaction` driven from the real page.
- **15 — an edited cart after a lost response.** The same interception,
  then add a second product before pressing Charge again. Proves: the
  route answers 409, the page shows "This sale was already recorded" with
  the first transaction's short id and "the cart has changed since";
  nothing is overwritten (the first transaction still has the first
  cart's lines and total); and because the page minted a new key on the
  409, a further Charge records a SECOND, separate sale with the edited
  cart — two transactions, the first untouched.
- **16 — permissions.** A `provider` (holds neither `financials.view_summary`
  nor `transactions.view`) sees no Financials entry in the nav and is
  redirected from `/financials`; the `front_desk`, which holds
  `transactions.view` WITHOUT the summary permission, is treated the same
  way and can still check out; and a role made for the run holding
  `financials.view_summary` WITHOUT `transactions.view` is refused too
  (the page requires both, so a holder of one never sees zeros with no
  error — `can.ts`). Proves the gate is the pair, on the nav, the route
  and the command palette, from both halves.
- **17 — late cancellation, without Stripe (three of four outcomes).**
  The builder writes an appointment and ITS cancellation token (the rows
  the booking route leaves; see §3 for why the token comes from the
  database). Three appointments, three links, through the public
  `/cancel/<token>` page as the client would: (a) starting in 3 days —
  "No fee", cancelled, nothing owed; (b) starting in 2 hours, the
  client's first offence — the page says the fee is waived as a
  courtesy, cancels, `late_cancellation_waiver_used` flips to true, NO
  ledger row; (c) starting in 2 hours, waiver already used, NO card on
  file — the page states the fee, cancels, the outcome is `uncollected`:
  no ledger row, the staff notification for an uncollected fee exists,
  the token is used. A second visit to a used link is the 410 page. The
  fourth outcome, `charge`, is journey 18.

### 3. Stripe: a second PR, gated the way Lokl gates it

Two journeys need Stripe: the late-cancellation **charge** (a saved card
charged off-session, the fee as a ledger row) and a **saved-card
checkout** (`stripe_card` tender, confirmed server-side, the card's last
four on the receipt). They go in the second PR, after the seven above are
green, because they need a secret the first PR does not.

**Gating, following `docs/testing-reference.md` §1:**

- A GitHub environment `stripe-sandbox` holding `STRIPE_SANDBOX_SECRET_KEY`:
  a RESTRICTED test-mode key (`rk_test_…`) limited to customers, payment
  methods, setup intents, payment intents and refunds — what the two
  journeys call and nothing else — and `STRIPE_SANDBOX_ACCOUNT_ID`, the
  sandbox account's id, so a key from any other account is refused at
  run time (`stripe.accounts.retrieve()` must return that id).
- A separate job `e2e-stripe` with the same steps as `e2e` plus the
  environment. Its first step checks the key: absent → `::notice` and
  every later step skipped, the job green (so the required check does not
  block PRs from forks or from anyone without the secret); present but
  not `sk_test_`/`rk_test_` → the job FAILS, loudly; present and test-mode
  → the account check, then the app is started with the key and the two
  journeys run under `--grep @stripe`. The ordinary `e2e` job never sees
  the key. A `concurrency` group on the job so only one run touches the
  sandbox at a time.
- `scripts/ci-start-app.mjs` passes the key through only when it is
  test-mode (it does today for `sk_test_`; it must accept `rk_test_` too —
  a one-line change in the second PR), and the journeys refuse to start
  without one, naming the environment.

**The cancel link in a test — from the database, not the mail catcher.**
The app sends mail through Resend's HTTP API, not SMTP, so the local
stack's Mailpit never sees it; in the test app `RESEND_API_KEY` is empty
and `sendMail` logs and returns false while the booking goes through. The
token itself lives in `cancellation_tokens` (no policies; the service
role reads it), minted by the booking route beside the appointment. The
builder therefore writes the appointment AND its token row, the pair the
route leaves, and the journey opens `/cancel/<token id>`. The email's
contents (the link, the location's time zone) stay covered by the
template unit test; reading the actual message would need Resend's test
mode, which does not exist. If a journey should prove the route mints the
token, journey 03's booking can be followed by a service-role read of the
token for that appointment — one assertion, in the first PR.

**18 — late cancellation, charged.** A client with a saved card (§4), the
waiver already used, an appointment in 2 hours. The public cancel page
states the $50 fee and that the card will be charged; confirm. Proves: a
PaymentIntent in test mode keyed `late-cancellation-fee-<token>`; ONE
ledger transaction with a `late_cancellation_fee` line and a
`stripe_card` payment of $50 carrying the intent id, written AFTER the
charge; `/financials` shows the fee as fees, not service or retail
revenue; the staff notification; and a second submit of the same link is
410 with no second charge (the token was claimed first). The failure
branch — a card Stripe declines (`pm_card_chargeDeclined`) — leaves the
token reusable, no ledger row, and a 402 the page shows in words.

**19 — checkout, card on file.** The same saved card at `/checkout`:
tender "card on file", Charge. Proves: the intent, the `stripe_card`
payment row with the intent id, the receipt naming the card's last four;
and a refund of it from `/transactions` pushes a Stripe refund first and
writes the mirror only on success (the route's 502 path with "nothing
was refunded" is asserted by making the refund fail — a second refund of
the same intent — in the harness, not the journey).

### 4. The builders `TestData` needs

| Builder | Writes | Notes |
| --- | --- | --- |
| `organisation(timezone, taxRateBps)` | `organizations`, one `locations`, four `roles` + `role_permissions` copied from the seeded organisation by role name | the run's organisation; `TestData.createOrganisation()` makes a `TestData` whose `orgId` is it |
| `role(name, keys[])` | `roles`, `role_permissions` | for the permission journey's "summary without ledger read" case |
| `staffMember(label, role)` | as today, in the run's organisation; `staff_locations` when the location matters | `front_desk`, `admin`, `provider`, or a run-made role |
| `client(first, last, { email, stripe_customer_id, late_cancellation_waiver_used })` | `clients` | the waiver flag set directly for journeys 17c and 19 |
| `service(name, staffId)` | as today | for the appointment |
| `product(name, { price_cents, stock_quantity, cost_cents })` | as today | stock known to the test |
| `giftCard(amountCents, { code })` | `gift_cards` | for a pay-with-card case that does not first sell one; journey 11 mints its card through checkout instead |
| `appointment({ … , withCancelToken })` | as today, plus a `cancellation_tokens` row (expires_at after the appointment) | returns the token id for `/cancel/<id>` |
| `savedCard(clientId, capturedBy, paymentMethod = "pm_card_visa")` | Stripe: customer + attached test payment method; `clients.stripe_customer_id`; `card_consents` (front-desk attested, policy text); `client_payment_methods` (brand, last4, expiry) | Stripe PR only; tracks the customer for deletion |
| `cleanup()` | `removeTestOrganisation` on the direct connection, then auth users, then Stripe customers; the zero-rows and no-orphans assertions | replaces the per-table deletes for a run that owns an organisation |

Nothing test-only enters the app: every builder writes the rows the
routes leave, through the service role or the direct connection, and the
journeys then act as a person would.

### 5. Cost

The `e2e` job on main today: 4 min 52 s, of which the Supabase stack
start is 2 min 05 s, the migrations 36 s, the build 41 s, and the eleven
journeys 30 s together. A money journey costs an organisation (five
inserts and a permission copy, ~1 s), a sign-in, two or three page loads
and the cleanup transaction: 5–10 s each on the runner, so the seven
non-Stripe journeys add roughly 60–75 s, taking the job to about 6 min.
The Stripe journeys add Stripe round trips (customer, payment method,
intent, refund: 1–2 s each) — about 30–40 s, in their own job that runs
in parallel with `e2e` and only when the key exists, so the critical
path grows by nothing when the secret is absent and by at most the
stack start plus ~45 s when it is. Fixed costs dominate; the journeys
themselves are cheap.

### 6. The split

- **PR 1 — the organisation fixture and the seven journeys without
  Stripe** (10–17): `removeTestOrganisation` in the cleanup helper with
  its assertions, the builders in §4 except `savedCard`, journeys 10–17,
  and the token read after journey 03's booking. No workflow change: the
  journeys run in the existing `e2e` job.
- **PR 2 — Stripe**: the `stripe-sandbox` environment (created by hand
  in GitHub, the restricted key and the account id as its secrets), the
  `e2e-stripe` job with the gate, `ci-start-app` accepting `rk_test_`,
  the `savedCard` builder with customer cleanup, journeys 18 and 19, and
  a `@stripe` tag the ordinary job excludes.

### As built — PR 1 (2026-10-08)

- `scripts/_cleanup.mjs` gained `removeTestOrganisation(dsn, orgId)`,
  catalog-driven as ruled: the scoped tables from `information_schema`,
  the unscoped ones reached through `pg_constraint` recursively (deepest
  first), then the two checks. The no-orphans check found residue on its
  first run: 100,000 `appointment_services` rows with no appointment,
  left by the load seed's `--clean`, whose comment said "lines cascade"
  — under replica mode nothing cascades. The seed now deletes the lines
  explicitly; the local residue was removed. On CI the stack is fresh, so
  the check fails there only on a real leak.
- `TestData.createOrganisation()` and the `org` fixture; builders `role`,
  `giftCard`, `appointment({ withCancelToken })`, `staffMember` with a
  run-made role, `client` with the waiver flag; `e2e/support/money.ts`
  holds the shared moves (pick the client, add a product, the Complete
  button named by its total, a `/financials` card by label, the run's
  ledger read back by organisation).
- Journeys 10–17 as in §2, with these as-built differences: journey 10
  takes the card at the terminal (no cash tender exists on the page);
  journey 11 reads the code from the sale's detail on `/transactions`
  (the route appends it to the gift card line's name, which the dialog
  shows — the one place a front-desk person can read it after the sale)
  and drives the over-balance refusal as a stale balance; journey 13's
  "Already refunded" is a second window of the same manager that still
  shows Refund after the first window refunded; journey 16 verified the
  front desk holds `transactions.view` without the summary, so it is the
  "one of the pair" case and no run-made role was needed for that half
  (one is still made for the other half).
- **A bug the journeys found, fixed in this PR** (the one app change):
  `/transactions` read `?open=` once, on mount. The "Already refunded"
  toast is shown on that page, so its "View refund" link only changed the
  query of a page already mounted and nothing opened — and the refund it
  named had been made elsewhere, so the page's list had never seen it.
  The page now watches the query after mount and refreshes its list
  before opening a row it has not seen. Journey 13 drove the click and
  failed before the fix, passes after.
- Journey 03 asserts the booking route minted the cancellation token.
- Cost measured locally: the eight journeys run in 14 s together; the
  full suite of nineteen in 33 s.

### As built — PR 2, Stripe (2026-10-08)

- **The gate** is `scripts/stripe-sandbox-check.mjs`, shared by the CI
  step and the journeys: the key must be `sk_test_` or `rk_test_`, and
  `stripe.accounts.retrieve()` must return the id `STRIPE_SANDBOX_ACCOUNT_ID`
  names; an error names the check that failed and never a value. The
  `e2e-stripe` job declares the `stripe-sandbox` environment and runs
  the gate as its first step: no key → a `::notice` and every later step
  skipped (`if: steps.gate.outputs.run == 'true'`), the job green; a key
  that is not test mode, or no account id → the job fails; otherwise
  the account check, the stack, the built app started with the key
  (`ci-start-app` now passes `rk_test_` through as well as `sk_test_`),
  and `npm run test:e2e -- --grep @stripe`. Its `concurrency` group is
  `stripe-sandbox`, so one run touches the sandbox at a time. The
  ordinary `e2e` job runs `--grep-invert @stripe` and never sees the key.
  `e2e-stripe` is not a required check.
- **`savedCard(stripe, clientId, capturedBy, paymentMethod)`**: a Stripe
  customer (test mode) with the test payment method attached, the
  customer id on the client, a front-desk attested `card_consents` row
  and the `client_payment_methods` row with the card's brand and last
  four. The customers are deleted at cleanup through the Stripe API,
  logged rather than failed if Stripe refuses. The decline branch uses
  `pm_card_chargeCustomerFail`, which attaches and then declines every
  charge; `pm_card_chargeDeclined` is refused at attach time by the
  current API, found on the first local run.
- **Journey 18** charges the fee through the public cancel page as
  designed and asserts the PaymentIntent in Stripe (succeeded, $50, the
  customer, the metadata, and the only intent on that customer), the
  ledger's fee line and `stripe_card` payment carrying the intent id,
  the spent link charging nothing on a second visit, the decline branch
  (the server's words in the page's alert, the appointment still booked,
  the token released, no succeeded intent), and `/financials` filing the
  fee as a fee with revenue at zero.
- **Journey 19** pays with the card on file from the checkout page's own
  "Card on file" tender, asserts the intent in Stripe, then refunds from
  `/transactions` and asserts the Stripe refund (one, $30, succeeded)
  and the mirror's payment carrying the same intent id. The receipt
  cannot name the card's last four: `/transactions` labels the method
  from a map that lacks `stripe_card`, so the row and the dialog show the
  raw value (board item); the journey asserts the amount and the intent.
- Locally both ran against the test-mode key in `apps/reserve/.env`
  (accepted by the gate in place of the sandbox key, with the same
  account check): 2 of 2 in 13.5 s; the ordinary suite excludes them.
- **The first CI run found a silent gap.** The gate and the account
  check passed on the restricted key, every later step ran, and both
  journeys failed with the app throwing "STRIPE_SECRET_KEY is not
  configured": the app reads the key from `runtimeConfig.stripeSecretKey`,
  whose run-time override is `NUXT_STRIPE_SECRET_KEY`, and the starter
  passed only the bare name — which reaches the app solely when the key
  was in the environment at BUILD time, as a laptop's `.env` is. Locally
  the key was baked into the build and the journeys passed; in CI the
  build has no key. The starter now passes `NUXT_STRIPE_SECRET_KEY`, and
  the local proof is a build with the key blanked at build time (the
  built server carries no key prefix) started through the starter: 2 of
  2, no "not configured" line in the server log. No Stripe call was
  refused under the restricted key.

### Open for the review

1. Journey 11 reads the minted gift card's code from the receipt line.
   If the receipt does not show it in the UI (the route appends it to the
   line's name snapshot), the journey reads it from `gift_cards` by the
   organisation — say which is acceptable as "the person's reachable
   path".
2. The appointment-and-token builder writes the token the booking route
   would have minted. The alternative — booking through the schedule UI
   in the test organisation and reading the token the route made — proves
   more and costs the provider hours and a slot search per journey; §3
   proposes one such assertion in journey 03 rather than per journey.
3. Whether the harnesses' hand-rolled test organisations move onto
   `removeTestOrganisation` in PR 1 or later.

## Relationship to other docs

- `docs/testing-reference.md` — the Lokl patterns this design is based on
- `docs/TODO.md` — the "dedicated CI Supabase project" punch-list item
  closes when PR A merges
- `.github/workflows/ci.yml` — both PRs add jobs here
- `docs/deployment.md` — the Playwright job requires `SUPABASE_SERVICE_ROLE_KEY`
  in the CI environment (not in the hosted Vercel env — only in the GitHub
  Actions environment for the local-stack jobs)
