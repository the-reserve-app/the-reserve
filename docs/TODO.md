# The Reserve — live board

Last updated: 2026-09-20. This is the working state of the project — what's
done, what's queued, what's blocked on whom. Update when the board changes.

## Phase status

DONE: §1 auth/staff/roles · §2 clients · §4 catalog · rooms · §5 scheduling ·
notifications · settings · theming · email (Resend) · docs pipeline (tbls) ·
§10–11 financials + dashboards · §9 messaging · §7 POS & payments
(migration 4a: ledger/checkout/refunds/gift cards/tax/receipts/audit —
gauntlet-verified; migration 4b: Stripe card-on-file with consent, charging,
refund-to-card, card removal, webhook — mini-gauntlet-verified, test mode) ·
§6 form engine + prospective onboarding THROUGH `approved` (2026-09-06/07,
detail below; the enroll → activate tail is QUEUED item 2, not done) ·
§8 lead capture (2026-09-13 → 18, QUEUED item 4 has the detail) ·
§9 messaging enhancements (2026-09-20, below) · scheduler reskin pieces
1–2 + collision layout + the CI gate (2026-09-19 → 20, below) ·
client communications lifecycle, ALL FIVE PHASES (2026-09-26 → 27,
docs/design/client-communications-design.md, PRs #7–#11): preferences +
waiver record, booking confirmation with cancel link, the four scheduled
touchpoints on pg_cron, cancel-via-link + the fee engine, and the
communication history + confirmation resend on the client profile.

### 2026-09-19 → 20 — what shipped, as the code shows it

- **Scheduler reskin, pieces 1–2 (docs/design/scheduler-redesign.md).**
  One card component for every view (`app/components/schedule/
  AppointmentCard.vue`: tint fill + provider-colour edge, no_show dimmed,
  cancelled never fetched); all three views fill the window and scroll
  under pinned headings; the hour scale stretches (percent of day, 720px
  floor). Loading moved to ONE six-week query for all views (decision
  recorded in the design doc with its scale caveat). **Collision layout
  BUILT** — parked item 4 no longer parked: week view width-splits
  time-chained clusters, density drops service then time, provider colour
  never dropped. Commits 8d49fdb · dabe07f · fdaa835.
- **Dashboard.** Bookings-by-day chart (this month over last, aligned by
  day of month, ApexCharts, gated on appointments.view.any, computed
  footer) · one shared `trend.ts` rule with a baseline floor (no
  percentage under 10 in the prior period; the KPI cards use it — two
  placeholder floors remain, punch list) · Today card's button hierarchy
  kept and made legible · one `DashboardScrollFrame` for the three list
  cards. Commits 036eca1 · db0670b · 5977dbd · 74cb2b8.
- **§9 messaging enhancements — DONE (docs/design/messaging-enhancements.md).**
  Right rail: DM contact card / group avatar stack (display-only), staff
  directory with per-row menu (chat / profile) and checkmark multi-select
  whose "Start conversation" REUSES the dialog's `useStartConversation`
  (one definition; a rail-made group is row-for-row identical to a
  dialog-made one — verified). All/Unread filter above the list, counts
  and membership from the ONE unread predicate, now
  `shared/messaging/unread.ts`. Messaging scars untouched (realtime
  channel naming, single-instance page, DM dedup, leave/GC). Commits
  0007702 · 9f51cd2 · 88adf9d · ffc36a1.
- **Tests.** Coverage triage → unit tests for the pure logic that matters
  (unread predicate, trend, useToggleSet, useStartConversation, DST +
  far-east-zone date cases); four rotted Aug-14 tests resolved (two
  fixed, one deleted, one was a REAL auth bug — see next); the suite runs
  green with exit 0 for the first time (18 files, 200 tests). Testing
  CONVENTION codified in CLAUDE.md: pure logic gets a unit test as
  built, DB-rule features get harness coverage as shipped, presentational
  components get neither; grep for the symbol before calling a module
  covered. Commits 2bbb62f · 212a49c · 84d2964.
- **Auth fix.** `usePermissions` cached a FAILED load as empty-and-ready,
  so the invite-acceptance race left a new staff member with a dead UI
  until hard reload — live since Aug 14, caught by the test that had
  never run. Failure now leaves state null and the next load retries;
  bounded to one retry per navigation. Commit 84d2964.
- **CI gate — ON.** `.github/workflows/ci.yml` runs typecheck + tests,
  lint, the database job and the e2e job on every PR and push to main
  (and e2e-stripe, not required, on the sandbox key). Branch protection
  on `main`: the four required checks `typecheck + tests`, `lint`,
  `database (local stack + harnesses)` and `e2e (built app + Playwright)`,
  pull request required, "do not allow bypassing" ON (the owner is gated
  too). The repository moved to the GitHub organisation on 2026-10-08:
  `github.com/the-reserve-app/the-reserve`, protection and the
  `stripe-sandbox` environment intact. **"Require
  approvals" is deliberately OFF** — a single collaborator cannot approve
  their own PR; turn it on the day the backend engineer joins. The lint
  sweep (real types for the ledger rows, dead vars, `Ui/**` override
  for CLI-written files) went through the gate as PR #1; lint was
  promoted to required in PR #2. First CI run also caught a live bug
  (the Zod adapter, punch list). Repo is PUBLIC as of 2026-09-20 (branch
  protection needs it on the free plan) — history audited, see the
  pre-launch item.

### §6 — what shipped, as the code shows it (2026-09-06 → 07)

Four migrations, all applied to the hosted DB: `form_engine`,
`form_links_and_public_submission`, `prospect_review_and_retention`,
`waiver_health_promotion`. Commits 219fa71 · 8b5a8d2 · 08baa4d · 1405867.

- **Engine.** `form_definitions` + immutable `form_versions` (fields jsonb
  carries `required` and `sensitive`); `form_responses` (non-health) split
  from `form_response_health` (gated by `clients.notes.health.view`);
  `prospect_intake` created at submit; `form_links` (single-use token,
  frozen `form_version_id`); `form_submission_attempts` (HMAC'd IPs,
  `FORM_IP_PEPPER`, fail-closed). Anon holds no write path anywhere — the
  submit RPC is service-role only with execute revoked.
- **Public submission.** `GET/POST /api/public/forms/:token`; page at
  `/join/:token` (moved off `/forms/**` before shipping so the auth
  exclude covers public pages only). Zod schema on the client is DERIVED
  from the shared field contract, and `tests/shared/formValidation.test.ts`
  asserts it agrees with the server's `validateAnswers` at the edges.
  Yes/No radios for boolean questions, neither preselected.
- **Review UI, through `approved`.** `/intake` list + `/intake/:id`;
  `submitted → under_review → approved | rejected` via
  `POST /api/prospects/:id/review`. Health answers are never fetched by
  the detail route — structural, not a permission doing the work.
  AS-BUILT DEVIATION from the design's seam note: the "stub `active` as
  create-a-client" was deliberately NOT built (08baa4d). Approve records a
  decision and creates nothing; there is no activate path at all. The
  end-to-end testability the stub was for came from the harnesses instead.
- **Retention.** 30 days for `prospect_intake` (allowlisted statuses, so a
  future `enrolled` is kept by omission), 24 hours for
  `form_submission_attempts`; both on pg_cron, scheduled in the migration.
  `verify:forms` asserts the OUTCOME (nothing past either window), since
  the app's roles cannot read `cron.job`.
- **Form builder.** `/forms`: create from seeded templates (`prospect_intake`,
  `service_waiver`), question editor (add / remove / reorder /
  edit; keys of already-answered questions are never re-keyed), publish
  the NEXT version — published versions never change.
- **Sending.** `POST /api/forms/:key/links` emails the link via Resend
  (best-effort; a failed send never fails issuance, and the dialog says
  which happened). Send dialog carries a client picker, so an
  existing-client waiver is addressable at all — before this every waiver
  attempt 422'd.
- **Existing-client waivers.** Health answers promoted into
  `client_notes(kind=health)` on submit — APPEND, one dated,
  version-stamped note per answer per submission — so they land in the
  tier whose reads are audited (`health_note.viewed`, now with a non-null
  `actor_user_id`). Client page shows "Completed forms" as provenance
  only, no health content. Multiselect answers promote as a joined string
  (the element-0 bug was caught and fixed in verification).
- **`requires_intake` booking gate.** `POST /api/appointments` reads the
  service flag and, under service role, requires ANY completed waiver in
  `form_responses` for that client; refuses with `needsIntake: true`
  otherwise. This was §6's original scope; the "requires_intake TODO" is
  closed. (Version-exact gating was considered and rejected — see design
  decision 12.)
- **Harnesses.** `verify:forms` 40/40 (anon write paths, health split,
  purge in both directions, retention canary); `e2e:forms` 14/14 (token
  single-use, rate limit limits, over HTTP). Both in package.json.
- **UI consistency, first two batches (60f15e3 · 001df8c · c564393).**
  `forms/index.vue`: answer-type `<select>` → `UiSelect` with a guarded
  setter, template-card disabled tokens, cards side-by-side from `md`.
  Then every remaining staff-page `<select>` → `UiSelect`: schedule ×3,
  services ×1, staff/[id] ×2 (the numeric day-of-week one bridged with a
  `String()`/`Number()` computed and its type round-trip proved). The one
  `<select>` left in `app/` is `JoinFormField.vue` — deliberate native,
  public page, commented as such.

NOT done, and not claimed: enroll → activate (below); Ask's allowlist is
NOT extended to the forms tables (open question in architecture.md; the
health tables are permanently excluded regardless); the pre-launch pepper
item still stands.

QUEUED (in order):

1. Memberships (§3) — BLOCKED on owner answers (see memberships-notes.md).
   Stripe Subscriptions on the 4b rails; unlocks the dashboard Members card.
   KEY CONSTRAINT: The Reserve is a MEMBERS-ONLY facility — membership is
   the gate to the business, not an upsell. Owns the enrolled → active half
   of the front door; item 2 owns the half before it, and Q8 is shared.
2. Onboarding ENROLL → ACTIVATE tail (§6, the half after `approved`) —
   OWNER-BLOCKED, moves with §3. Everything before it shipped (see §6
   block above). What remains is exactly: the `enrolled` / `active`
   states on `prospect_intake`, the enrollment action (tier + card on
   file, at the desk, with the person present), and client creation as
   its consequence. Shares owner question 8 with memberships.
   Do NOT build this on guesses about tiers, and do NOT add a
   "create client" button to the review page in the meantime — the route
   and page comments say why (08baa4d). When `enrolled` is added, the
   purge's status allowlist already keeps it.
3. Cancellation-fee engine — DONE 2026-09-26 for the cancel-via-link path
   (client communications phase 4); the staff-initiated path is on the
   punch list below.
4. Marketing (§8) — LEAD CAPTURE DONE 2026-09-13 → 09-18, all four
   phases (docs/design/leads-design.md): `leads` + `lead_notes` schema
   with the allowlist purge; the OPEN public capture endpoint
   (`POST /api/public/leads`, honeypot + per-IP limit + exact-origin CORS,
   org and origins as fail-closed config); the staff UI (`/leads`,
   `/leads/:id`, notes, status control) with the arrival-alert nav dot
   and bell; and conversion — "send intake form" issues the §6 link
   through `convert_lead()` in one transaction and threads
   `prospect_intake.lead_id` at submit. `verify:leads` 72/72.
   Marketing campaigns — DESIGNED 2026-09-26, NOT BUILT: the in-app
   campaign composer + send with server-side one-click unsubscribe, then
   webhook-backed analytics — see docs/design/marketing-campaigns-design.md.
   Still not designed: the marketing consent policy and the landing pages
   themselves (which live on the marketing site). Known residuals
   recorded in the leads design doc:
   per-IP limiting is evaded by distributed bots (CAPTCHA is the
   escalation, keyed to observed abuse); the marketing-consent POLICY is
   owner/legal-adjacent, the columns are ready for it.
5. UI polish sprint — after feature phases (see ui-polish.md).

## Punch list (small, unblocked, any-session)

- Create a separate STAGING Supabase project for Vercel preview
  deployments, built from the migrations (`supabase db push` against it,
  then `schema:compare` at zero differences), with its own
  `ask_readonly` password and test Stripe keys. Until it exists, preview
  deployments stay OFF: a preview must never carry the production
  database's keys (docs/deployment.md, decision 3 and "Branching and
  releases"). Added 2026-10-18.

- The year utilisation table (`pages/financials.vue`) and the dashboard
  bookings chart (`components/dashboard/BookingsChart.vue`) load every
  appointment in the period into the browser — a year is ~8,000 rows,
  paged past PostgREST's 1,000-row cap by `utils/allRows` since
  2026-10-08. Move both onto SQL aggregates in the shape of
  `transactions_page`: booked and scheduled minutes per provider, and
  non-cancelled bookings per local day for two months. Then `allRows`
  has no caller in those two places. Found by the demo seed, 2026-10-08.

- The dashboard logs eight "Hydration completed but contains
  mismatches" console errors on load (seen 2026-10-08 on the demo seed,
  signed in as an owner). Start by checking whether they predate the
  page-fixes PR of that day (`git stash` the branch, or check out the
  merge base, and load `/` again), then find which component renders
  differently on the server and the client.

- On or after 2026-11-08: remove the bare pre-NUXT_ names
  (`ASK_DATABASE_URL`, `FORM_IP_PEPPER`, `LEADS_ORGANIZATION_ID`,
  `LEADS_ALLOWED_ORIGINS`, `STRIPE_SECRET_KEY`) from the alias maps in
  `scripts/_env.mjs`. The app stopped reading them on 2026-10-08
  (docs/deployment.md, "Secrets at runtime"); the harnesses accept both
  until then so an older laptop `.env` keeps working.

- The `e2e-stripe` gate (.github/workflows/ci.yml) sits in the same job
  as the journeys, so every later step carries
  `if: steps.gate.outputs.run == 'true'` (14 of them). Move the gate into
  its own job that outputs `run`, and make the journeys a dependent job
  conditioned on that output, so the skip condition lives in one place.
  Suggested 2026-10-08 at the money-journeys PR 2 review.

- `/transactions` shows a card-on-file payment as the raw value
  `stripe_card`: its METHOD_LABELS map has card_external, gift_card and
  cash but not stripe_card, so the row and the detail dialog print the
  enum. Label it ("Card on file", with the last four if the row carries
  it) — found by journey 19, 2026-10-08.

- Move the harnesses' hand-rolled test organisations onto
  `removeTestOrganisation` (scripts/_cleanup.mjs, built 2026-10-08 for
  the money journeys, catalog-driven with zero-rows and no-orphans
  checks): `verify-tables`, `verify-presets`, `verify-audit` and
  `verify-messages` each delete their second organisation table by
  table today. Ruled "later" at the money-journeys design review.

- Trigram search never reaches its index under RLS (found 2026-10-08 by
  the policy-sweep PR 2 benchmark): `ILIKE`'s operator function
  (`texticlike`) is not leakproof, so in a security-barrier scan Postgres
  will not evaluate it ahead of the policy, and the GIN trigram indexes on
  `transaction_items.name_snapshot`, `payments.reference` and the clients
  columns are never used by the authenticated role — with sequential scans
  disabled the planner falls back to the organisation index and filters
  every row. Without RLS the same patterns use the trigram index at 4ms
  (payments) and 9ms (lines). Every search is therefore a filtered scan of
  the organisation's rows: fine at today's sizes (the ledger's year
  searches run at 80–240ms p50 on 87k lines), linear in the organisation's
  row count. The remedy, when a search case crosses its budget: a
  SECURITY DEFINER search function that scopes by organisation itself and
  checks the permission explicitly, so the trigram index condition is
  allowed (marking the operator leakproof needs superuser, which hosted
  does not give). That reopens server-tables decision 1 (the page
  functions run as the caller so RLS stays the backstop), so it needs
  the same conditions decision 1 set: a literal organisation predicate
  in every query the function builds, the permission check first, and
  the two-organisation harness case with real sessions proving the
  other organisation's rows never appear. `bench:tables`' index rule is
  scoped to clients and products until then.

- ~~EVERY read in the app pays a cost that grows with the data~~ DONE
  2026-10-08, the policy sweep (docs/design/policy-sweep-design.md): PR 1
  wrapped the helper calls in all 70 remaining policies as `(select …)`
  (the schedule's month view 119 → 2ms as an admin, 294 → 2.5ms as a
  provider) with `verify:policies` guarding it in CI; the audit log got
  its organisation column and a scoped policy (its own PR); PR 2 gave
  the ledger's lines and payments theirs (the DONE note at the end of
  this item). The record as it stood: every RLS
  policy called current_org_id() and has_permission() PER ROW. Measured
  2026-10-06 by the server-tables benchmark on clients: 255ms for a bare
  count(*) over 10,000 rows, 0.7ms once the two calls are wrapped as
  `(select current_org_id())` and `(select has_permission(…))` so
  Postgres evaluates them once per statement — same truth value, same
  rows. The clients policies are fixed (20261006 clients_policies_evaluate_once).
  The transactions, transaction_items and payments policies had their
  helper calls wrapped in server-tables PR 3, since its totals read them
  — but transaction_items_read and payments_read still carry an `exists`
  lookup on the parent transaction PER ROW, because the line tables have
  no organization_id of their own. Measured 2026-10-06 at about 90ms of
  every year-wide transactions_page call (1.7 million primary-key lookups
  over 20 runs at 51,516 transactions). The fix is `organization_id` on
  transaction_items and payments — a copy of the parent's, kept by a
  trigger, backfilled once — so their policies become the same plain
  column check as transactions_read. It touches every writer of those
  tables: the checkout route, the refund route and the fee engine's
  inserts, plus the backfill, and needs its own design before the sweep
  takes it. The rest — every other table's policies — is ONE dedicated
  sweep afterwards, proven the same way: the harnesses and journeys
  unchanged before and after, and a benchmark before and after on a
  seeded local stack. 2026-10-08: after the ledger_definition_views
  rewrite (transactions_page summing the ledger_lines view) the year
  window sits near its budget — p50 178 to 385ms and max 763ms against
  400ms / 800ms, up from about 160 to 325ms p50 — so the ledger
  `organization_id` change above is the recorded remedy, and the next
  benchmark that crosses the budget takes it.
  DONE 2026-10-08 (policy sweep PR 2, migration ledger_organization):
  `organization_id` on transaction_items and payments, kept equal to the
  transaction's by a composite foreign key (no trigger), backfilled once
  as the ledger's one sanctioned UPDATE, the two read policies the plain
  column check. Year window 392 → 283 ms p50 on the 50k seed; no
  regression elsewhere (docs/design/policy-sweep-design.md, PR 2
  as-built).
- ~~Pickers that load every row (found by the server-tables benchmark
  2026-10-06, when 10,000 seeded clients pushed a test client past the
  1,000-row cap): the schedule's booking dialog loads all active clients
  (app/pages/schedule.vue, `booking-clients`), checkout.vue loads all
  active clients and all active products, and the command palette caps
  clients at 500.~~ DONE 2026-10-07 (server tables PR 4): one shared
  `ServerSearchSelect` (app/components/ServerSearchSelect.vue, Lokl's
  SearchSelect server mode — 300ms debounce, AbortController, newest
  search wins in app/utils/latestSearch.ts) on the booking dialog, both
  checkout pickers, the forms send dialog and the command palette, each
  calling clients_page / products_page. Proven by journeys 03, 07 and 08
  booking, ringing up and opening a client who sorts past 1,100 fillers.
  Left loading whole: services, staff and the bookable-staff lists
  (bounded by the roster and the catalogue, not by growth).
- Ledger integrity (found 2026-10-06, investigated 2026-10-07 —
  docs/design/ledger-integrity-design.md): the "asserted by trigger"
  claim was false, and the bigger finding is that checkout, refund and
  the fee engine write header, lines and payments as three requests with
  compensating ledger DELETES under the service role, and nothing
  enforces append-only against that role. Two PRs approved: PR 1 the
  atomic, idempotent `write_ledger_transaction` with the three writers
  on it; PR 2 the deferred constraint triggers, the check, the
  update/delete block, the TRUNCATE revoke and `verify-ledger`. The 4a
  design doc and testing-design.md are corrected. BOTH BUILT 2026-10-08
  (PR #26, and the ledger_integrity migration): the ledger is now
  append-only for every role and balanced at commit.
- ~~audit_log has no organization_id, and audit_read is
  `has_permission('audit_log.view')` alone (found by the policy-sweep
  inventory 2026-10-08, docs/design/policy-sweep-design.md): any holder
  of audit_log.view in ANY organisation can read every organisation's
  audit rows through the API.~~ DONE 2026-10-08 (migration
  audit_log_organization): the column, backfilled by entity then actor,
  not null; the policy scoped; every writer setting it from a row it
  holds; append-only for every role on the shared `append_only_block`;
  the 30 hosted orphan rows (harness residue) deleted narrowly;
  `verify-audit` proves the two-organisation isolation.
- Client data erasure: a client with sales history cannot be deleted —
  the ledger references them (`restrict`, ledger-integrity-design.md) —
  so an erasure request must ANONYMISE the client record (name, contact
  details, date of birth, notes, address, emergency contact) while
  keeping the row for the ledger. Design it before the first request
  arrives: which fields, who may run it, the audit row, and what the
  ledger shows afterwards.
- Stripe test-mode harness for the late-cancellation fee writer (the
  cancel route needs a cancel token inside the fee window, a Stripe
  customer with a saved card and a live test-mode charge, so no harness
  drives it today; PR 1 covers it by calling the write function with the
  fee's exact rows) — and for ORPHANED REFUNDS: a Stripe refund that
  succeeds before its ledger write fails is not flagged by the webhook,
  which reconciles only `payment_intent.succeeded`. A retry recovers
  through Stripe's idempotency key only within Stripe's 24-hour window;
  after that a retry refunds twice.
- ~~Ask presets and prompt onto the shared revenue definition
  (docs/design/server-tables-design.md, decision 2): `revenue_this_month`
  groups tip, discount and late_cancellation_fee as revenue rows where
  the UI counts only service + product; the prompt's "a plain SUM over
  transactions … is usually what someone means by revenue" sentence
  contradicts its own gift-card rule and should go; the prompt's kind
  list omits late_cancellation_fee; `gift_cards_outstanding` means
  untouched cards where the UI means the sum of active balances; Ask
  buckets in the DB session zone (UTC, ISO Monday weeks) where the
  convention is the location's zone with Sunday weeks.~~ DONE 2026-10-08:
  the definition is the `ledger_lines` / `ledger_transactions` views
  (migration ledger_definition_views), `transactions_page` sums their
  columns, every money preset and the prompt read them with the
  location's calendar, and `verify:presets` proves each preset's figures
  equal `transactions_page`'s on a ledger fixture (docs/design/
  ask-the-reserve-design.md, "Revenue: one definition").
- Owner confirmations, server-tables decision 2 (ask, do not assume):
  (a) revenue stays GROSS of discounts with Discounts as its own figure
  — what the cards have always shown, now written down; (b) the
  late-cancellation fee shows as its own "Fees" card, outside revenue —
  the column comment's intent, now visible; (c) average ticket counts a
  late-cancellation fee transaction as a ticket — unchanged behaviour,
  carried into `transactions_page` as it was — which lowers the average
  on a day with fees; excluding fee-only transactions from the count is
  a one-line change. Each is a one-line change in `transactions_page`
  if the answer is otherwise.

- ~~LATENT CORRECTNESS BUG, fix deliberately, NOT in the scheduler reskin:
  the two-timezone seam.~~ DONE 2026-10-06: the grid's positions, the
  card labels and the dialog's slot labels use the location's zone through
  one shared module, shared/time/zone.ts, which the slots route imports
  too — one conversion, one zone, both sides. Proved by
  e2e/journeys/03-scheduler.spec.ts: a New York location, a Los Angeles
  browser, 10:00 AM asserted and shown. What is still on the browser
  clock outside the schedule is the next item. The entry as it stood:
  The schedule grid positions appointments and
  builds its day range from the VIEWER'S browser clock
  (app/pages/schedule.vue `blockStyle`, `fetchRange`), while the slots
  route computes availability in the LOCATION'S timezone
  (server/api/appointments/slots.get.ts, `localToUtc`). They agree only
  while viewer and location share a zone — true today, one city. Found by
  the scheduler behaviour inventory 2026-09-19; commented as a scar at
  both ends. The fix moves the grid onto the location's zone (the slots
  side is right); it needs its own verification across a DST boundary and
  a viewer in another zone, which is why it is not folded into a visual
  change.
- ~~Business time still on the browser clock, outside the schedule (the
  seam fix of 2026-10-06 covered the schedule page, its cards and its
  dialog only): the dashboard's today card (FrontDeskToday.vue, its own
  time formatter and a day window built from the browser) and week
  calendar (WeekCalendar.vue), the bookings chart's day buckets
  (BookingsChart.vue), the client profile's appointment dates
  (clients/[id].vue), and the communication history's timestamps
  (ClientCommunicationHistory.vue).~~ DONE 2026-10-07, wider than the
  five listed: the inventory found 15 business-time surfaces (also the
  KPI windows, new clients, gift cards, checkout's appointment label,
  transactions, forms, intake, leads, campaigns, time off), all moved
  onto `shared/time/format.ts` (zone required, no default) and
  `period.ts` key labels; date-only values (date of birth) format from
  the key, never through a Date; row counts through
  `shared/format/count.ts`. `tests/guards/browserClock.test.ts` bans
  every browser-clock call in app/ outside the messaging thread.
  Proof: journey 09 (12:30 AM New York on the location's day in a Los
  Angeles browser; a date of birth as stored) and unit tests in zones
  that differ from the runner's. Classification recorded in CLAUDE.md.

- KPI cards — permission gate discrepancy (owed since the dashboard
  shipped): the booking counts in app/components/dashboard/KpiCards.vue
  ("Appointments (7 days)", "Booked ahead", no-show rate) have no
  `can()` gate and rely on appointments RLS, so a viewer limited to
  appointments.view.own sees their OWN counts presented as the club's.
  The bookings chart (2026-09-19) gates on appointments.view.any for
  exactly that reason; the cards should match, or say "yours" when the
  viewer is own-only.
- KPI cards — trend-floor consistency (found 2026-09-19 with the chart
  floor): counts now use the shared app/utils/trend.ts baseline
  (TREND_MIN_BASELINE = 10 in the previous period). The no-show and
  revenue cards call the same function but pass `minBaseline: 1` — a
  DOCUMENTED PLACEHOLDER that preserves their pre-floor behaviour, not
  a floor. The real fix, per card:
  - No-show rate: the trend compares two RATES (percent), so the
    denominator that matters is the SAMPLE SIZE under each rate, not
    the prior rate's value. Floor on the prior window's booked count
    (the `total` inside `noShowRate`), e.g. ≥ 10 booked appointments in
    the prior 7 days, else no trend; the prior rate itself may be small
    and still be a perfectly good baseline. Needs `apptMetrics` to
    expose the prior window's count alongside the rate.
  - Revenue: the trend compares two CENT totals, so the floor is a
    DOLLAR AMOUNT on the prior week, e.g. ≥ $100 (10_000 cents) of
    service + retail, else no trend; a $12 prior week makes any normal
    week a 500% "surge". Pass it as `minBaseline` in cents.
  Either way the placeholder `minBaseline: 1` goes away, and the card
  comment in KpiCards.vue that points here comes out with it.
- @vee-validate/zod is a Zod 3 adapter on a Zod 4 project (found
  2026-09-20 by the first CI run): its peer is zod ^3.24 and it reads
  `issue.unionErrors` on invalid_union, which Zod 4 does not set, so any
  `.or()` / `z.union()` in a form schema throws an uncaught TypeError
  from the adapter on every invalid value. The only union (clients
  email) was rewritten as a refine in f0d6945; nothing stops the next
  one — this entry exists for the day a union schema is added. Fix for
  real: drop the adapter for vee-validate's Standard Schema support once
  a release accepts a Zod 4 schema directly, or pin a Zod-4-aware
  adapter. Until then: no unions in form schemas, refine instead.
- ~~Revoke TRUNCATE on append-only / access-by-token tables, project-wide~~
  DONE 2026-10-06, wider than planned: the explicit_api_grants migration
  revokes TRUNCATE, REFERENCES and TRIGGER from anon and authenticated on
  EVERY public table and in the default privileges for future ones, and
  the hosted/local grants comparison confirms no API role holds TRUNCATE
  anywhere. Original note kept for the reasoning:
  (found 2026-09-26 inspecting the phase-1 communications tables live):
  Supabase's default grants leave TRUNCATE for `authenticated` and `anon`
  on every table in public, and TRUNCATE bypasses row-level security.
  PostgREST does not expose it today, so the gap is theoretical — but for
  tables whose contract is that rows never disappear it is a real gap,
  not a style point. Small follow-up migration: `revoke truncate on
  <table> from authenticated, anon` for communications_sent,
  cancellation_tokens, audit_log, the ledger (transactions,
  transaction_items, payments), stripe_events, ask_queries,
  form_submission_attempts, and any other table whose integrity depends
  on rows never disappearing — enumerate by reading each table's
  append-only comment, not from memory. Model: the explicit
  `revoke insert, update, delete on communications_sent` in
  20260926160705, which states the intent as well as omitting the
  policy. Verify afterwards from pg: no TRUNCATE grant remains for
  either role on the named tables.
- ~~A dedicated system/bot staff row for service-role jobs~~ DONE
  2026-09-26 in the phase-4 migration (20260927020350): one
  `system@thereserve.local` staff row per organisation (inactive,
  unbookable, no login), `system_staff_id(p_organization_id)` get-or-create
  locked to the service role, uniqueness enforced by a partial index. The
  cancel-via-link fee transaction and its audit row are its first users.
  REMAINING: switch the phase-3 intake reminder's `form_links.issued_by`
  from the booking staff member to `system_staff_id()` — small route
  change, no schema.
- `campaign_unsubscribe_tokens.campaign_id` has no delete action (found
  2026-09-27 cleaning up the phase-1 campaigns test send): deleting a
  campaign is refused until its tokens are deleted by hand, while
  `campaign_recipients` cascades. Small follow-up migration: swap the
  constraint for `references campaigns(id) on delete cascade`, so a
  campaign delete takes its tokens with it. A footgun for every future
  cleanup until then.
- Staff-initiated cancellation UI (client communications, phase 4
  deferred — docs/design/client-communications-design.md, "Staff-initiated
  cancellations"): the scheduler's cancel path still does a direct status
  update with no fee logic. It should show the policy warning when the
  appointment is within 24 hours, show the client's waiver status, and
  offer an override with a reason; the fee engine itself
  (`server/utils/cancellationPolicy.ts` + the charge/ledger sequence in
  `server/api/public/cancel/[token].post.ts`) is ready to be called from
  a staff route. Until then a staff cancellation applies no fee and sends
  no cancellation notice — the link path does both.
- ~~verify:messages harness~~ DONE 2026-10-05 (`scripts/verify-messages.mjs`,
  39 checks, both directions, in CI's database job): DM dedup in both
  orders, group membership with repeats collapsed, unread derived from
  last_read_at with one bell entry per recipient, mark-read clearing the
  reader only, leave with garbage collection only on the last participant,
  and the prospect_intake status constraint equal to the union of the
  TypeScript sets (the review route's decisions and the queue's
  undecided set). REMAINING sub-item: cross-check the DB's unread
  derivation against `shared/messaging/unread.ts` across its eight
  tested edges — the harness asserts the derivation directly, not
  against the shared predicate.
- ~~Dedicated CI Supabase project so the verify:* harnesses can run in CI~~
  DONE 2026-10-05 the other way (docs/testing-design.md, PR A): no second
  hosted project — the `database` CI job starts a LOCAL stack in the
  runner, rebuilds it from supabase/migrations and runs verify:forms,
  verify:ask and verify:messages against it with no secret. Every harness
  reads credentials through `scripts/_env.mjs` and, under
  SUPABASE_LOCAL, refuses any URL that is not localhost or that came
  from the .env file. verify:leads joins when PR B's app-start script
  lands (it exercises the public endpoint over HTTP).
- ~~Explicit API grants migration~~ DONE 2026-10-06
  (20261006002816_explicit_api_grants, pushed): every grant the API
  roles hold is stated — select/insert/update/delete to anon and
  authenticated, all to service_role, sequences, the seven service-role
  functions, get_my_permissions — plus default privileges for future
  objects, with the four append-only revokes restated after the grants.
  `auto_expose_new_tables` is gone from supabase/config.toml; the CI
  stack and the hosted project are built from the migrations alone.
  Function grants made explicit the same way (20261006003546: EXECUTE
  on all functions to the three roles, then every revoke the migrations
  make restated, derived from their own `revoke execute` statements).
  Comparison afterwards, hosted versus a stack rebuilt from the
  migrations — table and sequence grants, function ACLs, default
  privileges, triggers, policies, indexes, constraints, cron,
  extensions: ZERO differences.
- ~~Schema drift found on the way~~ DONE 2026-10-06 (20261006002814, pushed): two functions
  and a trigger existed only on the hosted project, written in the SQL
  editor with no migration — get_my_permissions(), which every session's
  usePermissions() calls, and notify_timeoff_requested() with its
  trigger. Captured verbatim, then fixed (20261006002819): the bell
  notified approvers in EVERY organisation and formatted times in an
  arbitrary location's zone; now scoped to the requester's organisation,
  proven by verify:messages' two-organisation check (local stack only).
- Audit hand-written SQL that reached hosted outside migrations. The
  time-off trigger was written in the SQL editor and skipped review; the
  comparison (`npm run schema:compare`, zero differences after every push
  since, views and trigger state included since 2026-10-08) proves
  nothing ELSE differs now, but only running it keeps it that way. Look
  through the SQL editor's history for anything run against hosted that
  is not in supabase/migrations/, and for every hit decide: capture it
  as a migration, or revert it.
- Schema drift check before deploys. Before the Vercel deploy and before
  any new hosted project (staging, production), run `npm run
  schema:compare` (hosted against a stack rebuilt from the migrations:
  tables and views by column, constraints, indexes, policies, triggers
  with their enabled state, functions, views by definition, options and
  owner, grants, default privileges, cron, publication — in the repo
  since 2026-10-08, scripts/schema-compare.mjs) and require ZERO
  differences. It already runs after every hosted push (zero across
  2,381 objects on 2026-10-08); the open part is making it a step of the
  deploy checklist (docs/deployment.md has the line). Two functions and
  a trigger reached hosted with no migration; this is the gate that
  stops the next one. Every "zero differences" result before 2026-10-08
  compared views by column list only.
- `scripts/` is not linted: the ESLint config moved into apps/reserve/
  with the Turborepo migration (2026-10-05), so the root `npm run lint`
  (turbo lint) no longer covers the harnesses or `_env.mjs`. Either a
  root-level ESLint config for scripts/, or a `lint` script in a
  scripts workspace.
- Scheduler parked features (docs/design/scheduler-redesign.md "Parked"):
  grid availability / time-off shading, realtime live updates, richer
  per-status styling — each its own future project. Collision layout was
  the fourth and is BUILT (2026-09-20).
- First-run dashboard nudge — parked on docs/design/ui-polish.md
  (2026-09-20, after the sparse-data acceptance pass); pairs with the
  empty-states audit there.
- requirePermission helper adoption in checkout + refund routes
  (server/utils/requireUser.ts:23 does auth+permission in one call)
- receiptEmail return-shape consistency ({subject,html} object like the
  other templates; route destructures)
- Message thread pagination — designed, not built: keyset desc limit 50
  reversed, scroll-top older-page fetch with scrollHeight-delta
  preservation, dedupe by id. Current loadThread loads OLDEST 200 —
  latent bug at volume. Spec in docs/design/messaging-as-built.md; the
  2026-09-20 rail work deliberately did not touch loadThread.
- Tax on discounted base (GA taxes the discounted price; current math
  taxes pre-discount — matters only for discounted taxable retail)
- /settings title field: DB trigger blocks provider self-edit; settings
  form may need title shown read-only (unverified)
- Duplicate-card guard: refuse/reuse on Stripe card.fingerprint match
- Card-consent policy text → business settings page (hardcoded const in
  ClientCards.vue, TODO(business-settings) marks it)
- Checkout route single-DB-transaction hardening (writes are sequential
  inserts; an RPC wrapping them in one tx is the robust form)
- Remaining confirm() → themed dialogs: staff deactivate, invite revoke,
  availability deletes (opportunistic, when touching those files)
- Held/parked tickets (resumable carts) — only if the spa asks; lives
  OUTSIDE the ledger
- ~~audit_log.actor_user_id NULL across health_note.viewed /
  appointment.booked / pos.checkout~~ DONE 2026-09-06. Normalized once as
  `actorUserId()` in server/utils/requireUser.ts and applied to all four
  writers (health-notes, appointments, checkout, prospect review).
  Verified live: health_note.viewed now records a non-null actor_user_id.
  Found again, not by looking for it — an assertion that reading a
  promoted health note fires its audit surfaced the NULL on the very row
  being cited as proof of the audit invariant. Historic rows keep their
  NULLs; actor_staff_id was always populated, so nothing was untraceable.

## Pre-launch checklist

Deployment shape, the env-by-env matrix and the deploy checklist live in
**docs/deployment.md** — that doc is authoritative; the items below that
overlap it are pointers, not restatements (one fact, one place).

- Checkout has no cash option: `/checkout` offers the card terminal, a
  card on file and a gift card only, so a cash sale would be recorded as
  card, and the takings-by-method figures and the cash count would be
  wrong. The database already supports `cash` (`payments.method`, and
  `/transactions` labels it). Confirm with the owner how the spa takes
  payments, then add the tender or retire the value (found by journey 10,
  2026-10-08).
- Rotate the Resend API key (chat-exposed during dev) — see
  docs/deployment.md, deploy checklist + env matrix (RESEND_API_KEY).
- Rotate the DB password BEFORE THE VERCEL DEPLOY, not in the final
  sweep: it surfaced again in a tool error during the 2026-10-05 grants
  work (a connection string echoed by a failing script), on top of the
  earlier chat exposure. Rotating it changes TBLS_DSN and the ask DSN;
  docs/deployment.md, deploy checklist.
- ~~Rotate the Supabase SECRET key~~ DONE 2026-09-20. New `sb_secret_`
  key active; old key revoked in the dashboard. Verified both directions
  the same day: the new key serves service-role reads from scripts and
  from the restarted dev server (a service-role route answered with its
  own not-found, which it can only do after querying), and a request
  with the OLD value — taken from this clone's reflog remnant, the only
  place it ever existed — is refused by the project with 401
  "Unregistered API key". The remnant is therefore inert. History, kept
  so it is not re-litigated: the key was committed to `.env.example` on
  2026-08-22 at 21:59, removed at 21:59:46, rebased out at 22:01 before
  the next push; `origin/main` never pointed at those commits and
  anonymous web/API/fetch probes of the public repo report them absent
  (a same-day force-pushed-away control IS served, so the probe is
  sound); no JWT-shaped key ever existed in any commit, so an earlier
  note claiming a prior rotation was wrong — this was the one and only
  credential, and it is now rotated. OPTIONAL, cosmetic now: expire the
  reflog and prune to drop the dead value from the clone (discards local
  recovery history — owner's call).
- FORM_IP_PEPPER: a fresh, prod-specific value — see docs/deployment.md
  (env matrix; the fail-closed and re-anonymisation behaviour is
  explained there).
- Stripe: live keys, the prod webhook endpoint + its own signing secret,
  and the small real-money pass — see docs/deployment.md (deploy
  checklist; the CLI whsec_ is dev-only).
- Enable GitHub Secret Scanning on the repo (offered; one click — the
  repo is public now, so push protection may already be on; verify)
- ~~CI: GitHub Action running nuxt typecheck + vitest on PRs (before the
  backend engineer's first PR)~~ DONE 2026-09-20 — see the 09-19 → 20
  block: PR required, bypass off, and the four required checks
  `typecheck + tests`, `lint`, `database (local stack + harnesses)` and
  `e2e (built app + Playwright)` (the last two joined later; `e2e-stripe`
  runs but is not required).
- When the backend engineer joins: turn ON "require approvals" in the
  main branch rule (off today because a single collaborator cannot
  self-approve). ~~Move the repo into a GitHub organisation~~ DONE
  2026-10-08: `github.com/the-reserve-app/the-reserve`, with the four
  required checks and the `stripe-sandbox` environment carried over; the
  first CI run under the organisation is the docs PR that recorded the
  move.

## Verification debts (runtime checks owed)

- StaffEditSheet Roles section: confirm roles list renders + pre-checks +
  save works (after the description-column fix AND the toggle-set
  migration)
- Ask: verify the prompt cache is actually hitting. There are TWO cached
  prefixes now, not one — the system block (the schema, byte-identical on
  every ask) and the last prior-turn message (the conversation so far).
  Both have to hold, and the older baseline below could only see one of
  them. Check after a handful of real asks, before the cost normalises as
  "just what it costs":

      select created_at, thread_id, input_tokens, cache_read_tokens,
             cache_write_tokens, cost_micros
        from ask_queries where model is not null
       order by created_at desc limit 10;

  BASELINE 2026-09-05 (post-threading). What healthy looks like:

      first ask, cold window   cache_read=0             cache_write≈3218
      first ask of a thread    cache_read≈3218          cache_write=0
      follow-up, turn 2        cache_read≈3218          cache_write≈50–250
      follow-up, turn 3+       cache_read≈3400–3700+    cache_write≈50–250

  Read it as a shape, not a number. cache_read GROWS with thread depth —
  schema plus every prior turn — and cache_write COLLAPSES to the size of
  the one new turn once the schema has been written. A deep thread reads
  well past 3700; that is the system working, not drift.

  The failure the old baseline would have called healthy: a follow-up
  (same thread_id, not the first row for it) reading ~3218 and nothing
  more. That is the schema cache hitting while the conversation prefix
  misses — context caching is broken, every turn resends its predecessors
  at full rate, and thread cost goes O(n²) in depth. Against the old
  schema-only figure of 3218 that reads as a perfect hit, which is exactly
  why this entry was rewritten. Judge cache_read against the thread's
  depth, never against a fixed number.

  The other failures:

  - Zeros all the way down — nothing is caching, bill roughly 4.6x.
    Likeliest causes: the system prompt rebuilt per request, cache_control
    dropped, or something volatile creeping in ahead of a breakpoint.
  - A zero on the first ask of a cold window is expected, not a bug.
  - A thread past CONTEXT_DEPTH (20) legitimately loses the conversation
    prefix: the window slides, the oldest turn drops off, and the prefix
    changes every turn. Verified, not assumed — check depth before
    calling it a bug.

  SUPERSEDED baseline, pre-threading (single breakpoint, schema only), kept
  because it is what the numbers above are measured against:

      ask 1 (cold): in=225 out=78 cache_read=0    cache_write=3218  $0.0232
      ask 2 (warm): in=225 out=89 cache_read=3218 cache_write=0     $0.0050

## Blocked on the owner

- Membership tier definitions — the 12-question sheet in
  memberships-notes.md (Q12 added 2026-09-06: does any path to clienthood
  bypass membership enrollment? Blocks the "Add client" button's fate.
  NARROWED the same day: approval and enrollment are in-person only, so
  no remote path exists; what is left is the desk itself — walk-ins with
  no form, plus the Q9/Q11 guest and comp cases)
- The §6 enroll → activate tail (QUEUED item 2) waits on the same sheet.
