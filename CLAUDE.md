# The Reserve — conventions

- Branching and releases: `main` is production and is protected — every
  change lands through a pull request from a feature branch off `main`,
  the four status checks (typecheck + tests, lint, database, e2e) must
  pass, and nothing bypasses them. Required approvals are OFF until a
  second engineer joins; turning them on is the step to take that day.
  There is no long-lived development branch: Vercel's preview deployment
  of each PR serves that purpose once Vercel is connected, and a preview
  NEVER carries the production database's keys — so preview deployments
  stay OFF until a separate staging Supabase project exists for them to
  point at (docs/deployment.md, "Branching and releases").
- Migrations: npx supabase migration new <name> → review → npm run db:push
  (chains typegen + tbls docs). NEVER edit applied migrations.
- Push-first when one change adds columns/tables AND the route code reading
  them: apply the migration so typegen emits the types, THEN write the call
  site. A type shim silencing errors on the table you just changed is the
  failure mode — it disables checking exactly where the schema moved.
  Nuance: push needs approval, so if the consumer must exist first to make
  the change reviewable, the shim is an acknowledged cost, marked and
  deleted the moment typegen lands. Default is push-first; shim is the
  exception you justify.
- Layout: a Turborepo workspace; the app is apps/reserve (@repo/reserve) and
  supabase/, docs/, scripts/ stay at the root. Paths in the conventions, the
  skills and the design docs are relative to `apps/reserve/` unless they
  begin with `supabase/`, `docs/` or `scripts/`.
- After adding components/composables: npx nuxt prepare (from apps/reserve)
  + TS server restart ("the ritual")
- UI: ui-thing components (npx ui-thing@latest add <name>); lucide icons ONLY (no heroicons)
- Money: ALL pricing math server-side in routes; ledger is append-only;
  refunds are negative mirrors; gift cards/credits are liabilities not revenue
- Auth in routes: requireUser(event) returns { user, client } — but `user` is
  DECODED JWT CLAIMS, typed as a Supabase User. The auth user id is the `sub`
  claim, NOT `.id`. `user.id` typechecks and is undefined at runtime, which
  is what wrote NULL into audit_log.actor_user_id across health_note.viewed /
  appointment.booked / pos.checkout. Use `actorUserId(user)` from
  `server/utils/requireUser.ts` (`sub ?? id`, accepting both so a library
  change can't reintroduce it); never reach into the user object. Staff
  identity via current_staff_id() RPC; permission RPC param is `perm`
  (NOT p_key)
- Dates: a day-granular key ("YYYY-MM-DD") comes from `shared/time/`
  only — `localDateKey(instant, zone)` / `todayKey(zone)` for an instant
  in the location's zone, `shiftDays` and friends for arithmetic. Never
  toISOString() (UTC first, wrong day in the evening) and never
  toLocaleDateString: `tests/guards/browserClock.test.ts` fails the suite
  on any toLocale* in app/. The full rule is the time-zone section below.
- Time zones: BUSINESS time — an appointment, opening hours, which day
  something falls on — formats and buckets in the LOCATION's zone, through
  `shared/time/zone.ts` (one module for the slots route and the schedule,
  so the instant a rule becomes and the pixel a card lands on come from
  the same conversion). Every helper there takes the zone as a parameter;
  the page reads it once via useLocationTimezone(). Never the browser's
  clock for business time: a Los Angeles browser drew a 10:00 AM New York
  appointment at 7:00 AM (the two-timezone seam, fixed 2026-10-06, proved
  by e2e/journeys/03-scheduler.spec.ts). The classification, applied to
  every surface 2026-10-07 (journey 09 is the proof):
  (1) BUSINESS time — appointments, opening hours, which day or week
  something falls on, and records of what the business did: sales,
  communications and campaigns sent, leads received, time off, a client's
  record, forms and notes — formats through `shared/time/format.ts`
  (dateLabel, dateTimeLabel, rangeLabel, monthName; the zone is a
  REQUIRED argument, no default) and buckets through `period.ts`
  (periodRange, rollingDays, Sunday weeks). No surface makes its own
  Intl date call or Date-getter arithmetic.
  (2) PERSONAL event time — when a message was sent in the messaging
  thread — may use the viewer's clock. It is the only allowlist entry in
  `tests/guards/browserClock.test.ts`, which fails the suite on any
  toLocale*/Intl.DateTimeFormat/Date getter-setter in app/ otherwise.
  (3) DATE-ONLY values — a date of birth, any `date` column — never pass
  through a zone or a Date at all: `keyLabel` formats the "YYYY-MM-DD"
  string itself. `new Date("1990-05-03")` is UTC midnight and reads as
  May 2 in a US browser. Calendar arithmetic on keys is `shiftDays`/
  `shiftMonths`/`weekdayOf`; the only browser-zone read is
  `shared/time/picker.ts`, recovering the day a date picker's Date
  denotes. Row counts: `shared/format/count.ts`, so `toLocaleString` is
  banned in app/ outright.
- Hosted harness runs never write into an append-only table: audit_log
  and the ledger refuse UPDATE and DELETE for every role (since
  2026-10-08), so a row a hosted run creates can never be removed, and
  creating staff or granting a role writes an audit row through the
  staff_roles trigger. A harness case that creates staff, grants a role
  or writes audit or ledger rows runs on the LOCAL stack only and prints
  a `skip` line on hosted; local cleanup removes a run's audit rows — what
  its staff wrote AND what the trigger wrote about them — through
  `scripts/_cleanup.mjs` (direct postgres connection, replica mode,
  localhost guard). The 30 orphan audit rows this rule exists for were
  harness residue on hosted, deleted by the audit_log_organization
  migration. A script that must never run against hosted (ledger and
  audit harnesses, the load seed, the benchmark, the app starter) calls
  the shared `requireLocalStack()` from `scripts/_env.mjs`, never an
  inline guard: that call is the marker
  `tests/guards/ciLocalOnly.test.ts` reads, and it fails the unit suite
  on any CI step that runs such a script without SUPABASE_LOCAL=true.
- After a hosted push: `npm run schema:compare` (hosted versus the local
  stack built from the migrations) must report zero differences. Since
  2026-10-08 it compares views by definition, options and owner and
  triggers by enabled state; every zero-differences result before that
  compared views by column list only.
- Secrets and server settings: read at RUN TIME from runtimeConfig under
  the NUXT_ name, with a literal empty default in nuxt.config.ts — never
  `process.env` there, which Nuxt inlines into the server bundle at
  build (a laptop build carried nine secrets, 2026-10-08). The registry
  is `shared/config/settings.ts`; `tests/guards/runtimeConfigDefaults.test.ts`
  fails on a process.env default; `verify:build-secrets` builds with
  sentinels in CI and proves none lands; `server/plugins/config-report.ts`
  names what is missing at startup, never a value. A route that needs a
  setting refuses with a 503 that names the NUXT_ variable.
- Command chains: steps are joined so a failure stops the chain (`&&`,
  or `set -e` in a script), never with a plain `;`. An irreversible step
  — a hosted db push, a merge, a delete — never runs in the same chain
  as the steps that justify it; it runs as its own step, after their
  results have been read and checked. The failure mode, 2026-10-08: a
  header fix in a migration file raised on a text mismatch, the chain
  continued through the repair and the hosted push, and the file was
  applied uncorrected — then could not be corrected, because applied
  migrations are never edited.
- Silent-failure assumptions: when a change depends on something that
  produces NO error if false — a cache hits, a prefix is stable, a harness
  actually connected, an optimization fires — make verifying it a build
  step, and measure the specific signal that would be wrong if it failed.
  A green suite does not prove an assumption the suite doesn't check.
  Caught this way, all three passing every gate: a verify harness counting
  connection failures as PASS; an editor-restored duplicate module (the
  diff showed a modification where a rename was expected); a sliding-window
  cache miss that just costs more, quietly, later.
- Two paths deciding one predicate: derive once, or test the disagreement.
  This project deliberately enforces rules in Postgres, so the same
  question routinely gets decided in two languages — a plpgsql function
  and the TypeScript route calling it — where one shared implementation is
  impossible. The architecture GENERATES this bug class; it is expected,
  not incidental, and it always fails the same way: both sides agree on
  the common case and diverge at an edge, so every ordinary test passes.
  Two tiers.
  (1) When they CAN share, derive it once and make divergence
  unrepresentable. `shared/ask/format.ts` is the model: caption and table
  each formatted `_cents`, drifted, and a single-cell result read
  "Avg spend: 4064" in the caption above "$40.64" in the table (42290e5).
  One contract, and the bug stopped being expressible.
  (2) When they CANNOT share — one side is a database function — test the
  edge where they would disagree, never the common case where they agree.
  Real instances: the submit route decided "prospect link" as
  client_id-null AND key=prospect_intake while submit_form_response
  decided it as client_id-null alone, so a subject-less link on any other
  form sent NULL into a NOT NULL column (23502) — the DB-layer harness was
  31/31 green while that hole was open, and only an end-to-end test found
  it. The public form treated `false` as unanswered while the server
  treated it as the answer "no", silently discarding every explicit No and
  making a required yes/no question unanswerable. The forms editor locked
  all four contact keys when the contract required three, quietly making
  `phone` uneditable. `tests/shared/formValidation.test.ts` is the shape
  to copy: it asserts the two sides AGREE across deliberately awkward
  inputs, so drift fails the test regardless of which side is right.
  The seam between `shared/ask/presets.ts` ids and `PRESET_SQL` keys (an
  unpaired preset silently falls through to the LLM) is asserted both
  ways by `npm run verify:presets`: every chip has a query and every
  query is reachable from a chip.
- "Built" means a human can complete the flow from the UI. Not that the
  machinery exists. The failure mode is specific and it passed every gate:
  schema applied, route written, typecheck 0, unit tests green, boundary
  harness green — and a real person still could not do the thing, because
  the human-facing caller was never written. Three in the forms feature
  alone: no way to CREATE a form (the empty state shipped the gap as a
  sentence, "created through the API for now"), no way to SEND one (the
  route minted a link and left delivery to the staff member's own email
  client), and no way to send a waiver AT ALL (the dialog collected an
  address but never a client, so every attempt 422'd). Each was
  "schema + route done, caller never written", and each was described as
  finished. So: "works end to end" is a claim about the USER'S REACHABLE
  PATH, not about the code's capability, and it is earned by driving the
  actual loop — open the page, click the button, receive the email, read
  the result — with no curl, no service-role script, and no copy-paste
  step standing in for a missing screen. If a step in the demo is "then a
  developer runs...", the feature is not built. Corollary: an empty state
  or a comment admitting the gap is not a mitigation; it is the gap,
  written down and shipped.
- Types: npm run typecheck (root, via turbo) or npx nuxt typecheck (from
  apps/reserve) must stay at 0; payloads feeding insert+update
  typed as Omit<TablesInsert<"t">, "organization_id">
- Every new table: organization_id + org-scoped RLS (see docs/design/multi-tenancy-status.md).
  A child table reaches its organisation through its parent in the policy
  (`exists (select 1 from parent …)`) UNLESS it is read at volume: the
  ledger's lines and payments carry their own organization_id, kept equal
  to the transaction's by a composite foreign key, because the per-row
  parent lookup was ~90ms of every year-wide financials query
  (policy-sweep-design.md, PR 2). Same rule for the next hot child.
- RLS policies: every helper call is wrapped as a scalar subquery —
  `organization_id = (select current_org_id()) and (select
  has_permission('x'))` — so Postgres evaluates it once per statement
  instead of once per row (255ms → 0.7ms on a 10,000-row count).
  `scripts/verify-policies.mjs` runs in CI and fails on a bare call; its
  only allowlist is the four correlated `is_conversation_participant(…)`
  calls, which take the row's own column by design.
- Append-only tables (the ledger's three, audit_log) refuse UPDATE and
  DELETE for EVERY role through one shared trigger function,
  `append_only_block()`, and TRUNCATE is revoked from service_role; "no
  policy" alone never bound the service role. A new append-only table
  gets the same trigger and revoke, not a comment.
- Tests, by what the code is: a new pure-logic utility or composable
  gets a unit test as it is built (tests/ mirrors the source path);
  a new feature whose rules live in Postgres gets harness coverage as
  it ships, in the verify-*.mjs shape (both directions, non-vacuous);
  presentational components (cards, frames, rails) get no unit test —
  they are proven by driving the page. A test file that sits beside a
  module is not evidence the module is covered; grep for the symbol.
