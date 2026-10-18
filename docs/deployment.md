# Deployment (Vercel) — design + checklist

Status: DESIGN + CHECKLIST, not yet deployed. Written 2026-09-20.
Nuxt-on-Vercel is well-trodden; the real content here is the INTEGRATION
decisions (Supabase, Stripe, the ask pg connection) and the env-by-env
checklist, not the framework fit.

## The decisions that will misbehave if unplanned

### 1. ASK_DATABASE_URL must use the Supabase POOLER, not the direct connection

The sleeper issue. Ask The Reserve runs generated SQL over a DEDICATED
pg connection (the ask_readonly LOGIN role) — a raw Postgres connection,
not PostgREST. On Vercel each function invocation is a separate
short-lived serverless instance, and raw pg connections do not pool
across invocations: every cold function opens a new connection, and under
load they pile up and exhaust Postgres's connection limit.

This WORKS IN TESTING (low volume, connections don't accumulate) and
BREAKS IN PROD (connection exhaustion). Classic works-in-dev-fails-at-load.

Fix: in production, ASK_DATABASE_URL points at Supabase's connection
POOLER (port 6543, transaction mode), not the direct connection (5432),
and the pg client is configured for serverless — small or no client-side
pool, short idle timeouts — so the pooler manages connection reuse. The
ask_readonly role + its password stay the same; only the host/port/mode
in the DSN change from direct to pooled.

Verify after deploy: run several ask queries in quick succession against
the deployed app and confirm no connection-limit errors; check Supabase's
connection count doesn't climb unbounded.

### 2. Region co-location with Supabase

Supabase is in aws-1-us-west-2 (per the DSNs). Vercel functions must be
pinned to the SAME region, or every DB query pays a cross-region
round-trip — and nearly every route hits Supabase, so a region mismatch
is a latency tax on the whole app. Set the Vercel function region to
us-west-2 to match Supabase.

### 3. Preview deployments must not touch prod resources

Vercel auto-deploys every PR to a preview URL. Those previews would
otherwise carry the public endpoints (lead capture, form submit) and,
if misconfigured, a live Stripe webhook — a preview must never accept
real leads, write real data, or be a registered Stripe endpoint.

Use Vercel's PER-ENVIRONMENT env vars (production / preview / development):
- Preview gets TEST Stripe keys, a non-prod or empty LEADS_ORGANIZATION_ID,
  and must NOT be a registered Stripe webhook endpoint.
- Only PRODUCTION carries live Stripe keys, the prod webhook secret, the
  real LEADS_* values, and the prod FORM_IP_PEPPER.
- Consider Vercel's preview protection (password) so previews aren't
  publicly reachable at all — but note the Stripe webhook route on PROD
  must NOT be behind any such protection, or Stripe can't reach it.
- A preview NEVER uses the production database's keys: no production
  `NUXT_PUBLIC_SUPABASE_URL`, publishable key, secret key or ask DSN in
  the preview environment. There is no second database to point them at
  yet, so **preview deployments stay OFF until a separate staging
  Supabase project exists** (board item in docs/TODO.md); until then a
  change is tried on the local stack (`npm run build:check && npm run
  app:start`) and the CI journeys.

## The decisions that are already right by design

### pg_cron stays in Supabase — deployment-independent

The retention purges (prospect 30d, telemetry 24h, leads 1 month) run via
pg_cron INSIDE Postgres, not in the app. This is a deployment advantage:
serverless hosts have no persistent process to run cron, so an app-level
scheduler would have been a problem on Vercel. Choosing pg_cron over an
external scheduler (originally for the silent-failure reason) also means
scheduled work needs nothing from Vercel — it keeps running regardless of
deploys. No Vercel Cron, no worker process needed.

### The verify:* harnesses and TBLS_DSN are tooling, not runtime

The harnesses insert/delete against a database with the service role —
they are CI checks against a local stack and local pre-merge checks,
never part of the deployed app (the ones that create staff or write
ledger or audit rows refuse to run against hosted at all). TBLS_DSN
generates schema docs locally and feeds `schema:compare`. None of this
belongs in the Vercel runtime env or the deployed bundle. The Vercel build command is
`turbo build --filter=@repo/reserve` with the project root at
`apps/reserve/`; confirm it does not invoke scripts/ or the harnesses.

## Sequencing: Turborepo before Vercel — DONE 2026-10-05

The Turborepo wrap landed before any Vercel configuration
(docs/turborepo-migration.md): the app is the `@repo/reserve` workspace at
`apps/reserve/`, `supabase/`, `docs/`, `scripts/` and CI stay at the root,
and nothing is extracted into `packages/`. Vercel is therefore configured
ONCE, for the monorepo shape: project root `apps/reserve/`, build command
`turbo build --filter=@repo/reserve`, install command `npm ci` at the
repo root (workspaces), output `.output` under the app. Remote caching is
off until a second engineer makes parallel CI runs worth it.

Also relevant: the marketing site (which hosts the landing pages that POST
to the lead-capture endpoint) is a SEPARATE surface. Decide where it lives
— a second Vercel project in the same monorepo is clean and makes
LEADS_ALLOWED_ORIGINS point at a known Vercel origin. Its origin is what
goes in LEADS_ALLOWED_ORIGINS on the app's production env.

## Secrets at runtime (2026-10-08)

Every server-side setting is read AT RUN TIME from `runtimeConfig` under
its `NUXT_` name, and `nuxt.config.ts` gives each an empty default —
never `process.env`. Before this, every private value took its default
from the build environment, which Nuxt INLINES into the server bundle:
a local build made with the laptop's `.env` carried nine secrets (both
webhook secrets, the Anthropic key, the ask connection string with its
password, the pepper, the job secret, the Supabase secret key) in
`.output-check`. The built outputs never left the machine: no build
folder was ever committed (full history, all refs), and the three CI
artifacts ever uploaded and every job log hold only the CLI's public
local keys and expired local test sessions.

Three things keep it so:

- `tests/guards/runtimeConfigDefaults.test.ts` fails the unit suite if
  any private `runtimeConfig` value in `nuxt.config.ts`, the Supabase
  module's keys included, takes its default from `process.env`.
- `npm run verify:build-secrets` (both e2e CI jobs build through it):
  builds with a distinct SENTINEL value for every setting in the
  environment, fails if any sentinel or any secret-shaped string is in
  the output or any private setting is inlined non-empty, then starts
  the built server with everything blank and asserts its startup report
  names every missing setting and two fail-closed routes answer 503
  naming theirs.
- `server/plugins/config-report.ts` prints at startup one line per
  setting, set or NOT SET with what refuses — never a value — from the
  registry `shared/config/settings.ts`.
- Every route that needs a setting refuses with a 503 that names its
  `NUXT_` variable, the Stripe client included: `useStripe()` throws that
  503, so card-on-file checkout, card refunds, the late-cancellation fee
  charge and the webhook never surface a missing key as a generic 500,
  and the Stripe webhook checks its own signing secret before anything
  else. `verify-build-secrets` probes the webhook for exactly this.

The old bare names (`STRIPE_SECRET_KEY`, `ASK_DATABASE_URL`, …) are no
longer read by the app at all. `scripts/_env.mjs` still accepts them for
the harnesses UNTIL 2026-11-08, after which its alias maps lose them;
`.env.example` and the harness docs use the `NUXT_` names only.

## Environment variables — the completeness matrix

Every one must be set in Vercel, per environment, under EXACTLY this
name. "Runtime" means the value is read when the server handles a
request or starts; it need not exist at build. "Build" means the Supabase
module validates it when the app is built, so set it for the build too
(it is public). Many are FAIL-CLOSED: missing one is a visible feature
outage, not a silent bug (by design), and the startup report names it.

| Var | Build or runtime | Prod value | Notes |
|---|---|---|---|
| NUXT_PUBLIC_SUPABASE_URL | build + runtime | prod project URL | public |
| NUXT_PUBLIC_SUPABASE_KEY | build + runtime | publishable key | public, safe to expose |
| NUXT_PUBLIC_SITE_URL | runtime | the deployment's own public URL | links in outbound email (cancel link, phase-3 reminders); per environment — preview gets the preview URL, never prod's |
| NUXT_PUBLIC_STRIPE_PUBLISHABLE_KEY | runtime | LIVE publishable | test in preview |
| NUXT_SUPABASE_SECRET_KEY | runtime | the ROTATED secret key | server-only; rotated 2026-09-20; the Supabase module reads it at run time |
| NUXT_ASK_DATABASE_URL | runtime | POOLER DSN (6543, tx mode) | NOT the direct connection — see decision 1 |
| NUXT_ANTHROPIC_API_KEY | runtime | the-reserve project key | server-only |
| NUXT_STRIPE_SECRET_KEY | runtime | LIVE key | test key in preview only |
| NUXT_STRIPE_WEBHOOK_SECRET | runtime | PROD webhook's secret | per-endpoint; NOT the CLI whsec_ |
| NUXT_RESEND_API_KEY | runtime | rotate before launch | was chat-exposed; pre-launch rotation |
| NUXT_MAIL_FROM | runtime | verified sender domain | must be verified in Resend |
| NUXT_RESEND_WEBHOOK_SECRET | runtime | the PROD Resend webhook's signing secret (whsec_…) | fail-closed; per-endpoint; campaign engagement events (marketing campaigns, phase 2) |
| NUXT_COMMUNICATIONS_JOB_SECRET | runtime | `openssl rand -hex 32` | fail-closed; the scheduled communications route refuses without it; SAME value as the Vault entry below |
| NUXT_FORM_IP_PEPPER | runtime | a DIFFERENT prod value | fail-closed; per-env; openssl rand -hex 32 |
| NUXT_LEADS_ORGANIZATION_ID | runtime | the real org id | fail-closed; empty in preview |
| NUXT_LEADS_ALLOWED_ORIGINS | runtime | the marketing site's real origin | never *; fail-closed cross-origin |
| TBLS_DSN | neither — NOT deployed | — | tooling only (schema docs, schema:compare) |

### Supabase Vault entries (the scheduled communications, phase 3)

Two entries, inserted by hand in the Supabase dashboard (Project Settings
→ Vault) BEFORE the phase-3 migration is pushed — the four nightly
communication jobs read them on every tick and fail visibly in
`cron.job_run_details` from the first run if either is missing. Neither
is in the repo or in the migration.

| Vault name | Value |
|---|---|
| `communications_site_url` | the deployed app's base URL — the SAME value as NUXT_PUBLIC_SITE_URL |
| `communications_job_secret` | the bearer secret — the SAME value as NUXT_COMMUNICATIONS_JOB_SECRET (`openssl rand -hex 32`) |
| `resend_webhook_secret` | the Resend webhook's signing secret — the SAME value as NUXT_RESEND_WEBHOOK_SECRET. Recorded here so every secret is in one place; nothing in Postgres reads it (Nitro routes cannot reach Vault, so the route reads the env var) |

The Resend webhook (marketing campaigns, phase 2) is the other
deploy-only path: Resend cannot POST to localhost, so `POST
/api/webhooks/resend` is registered in the Resend dashboard against the
deployed URL (events: opened, clicked, unsubscribed, complained,
bounced) and its signing secret goes into NUXT_RESEND_WEBHOOK_SECRET. Locally
it is proven with a signed simulated POST — see the phase-2 PR.

The path is pg_cron → `run_communication_job()` → pg_net → `POST
/api/jobs/communications`. It only works once the app is DEPLOYED: pg_net
cannot reach localhost from the hosted Supabase. Locally, call the route
directly with the job secret as a Bearer token and `{"job":
"day_before_reminder"}` (or whichever job) as the body; the same
verification applies — check the sent-log, confirm the email.

NUXT_FORM_IP_PEPPER, in more detail (moved here from the board): it keys the
HMAC over visitor IPs on the public intake form, so it must DIFFER per
environment, and rotating it re-anonymises history — existing
form_submission_attempts rows stop matching new hashes, which resets the
rate-limit counters rather than corrupting anything. Absent, the public
submission route refuses to serve: fail-closed on purpose, so a missing
secret shows up as an outage, not as silently weaker hashing.

## Branching and releases

- `main` is production. It is protected on GitHub: a pull request is
  required, the four status checks must pass (`typecheck + tests`,
  `lint`, `database (local stack + harnesses)`, `e2e (built app +
  Playwright)`), and nothing bypasses them, administrators included. `e2e-stripe` runs on every PR
  but is not required, because it depends on the sandbox secrets.
- Every change is a feature branch off `main`, merged through a PR and
  deleted afterwards. There is no long-lived development branch.
- Previews stand in for one: once Vercel is connected, every PR gets a
  preview deployment, and that is where a change is tried before it
  merges. A preview never uses the production database's keys — it
  reads Vercel's PREVIEW environment, per decision 3 above, never the
  production one — so preview deployments stay OFF until a separate
  staging Supabase project exists for them to point at.
- Required approvals are OFF for now: one engineer cannot approve their
  own PR, so the rule would only block. **When a second engineer joins,
  turning on required approvals (one review) in the `main` branch
  protection is the step to take.** Nothing else in this workflow
  changes that day.

## Deploy checklist (pre-launch)

Before first production deploy:
- [x] Turborepo wrap done (2026-10-05, docs/turborepo-migration.md).
- [ ] Vercel configured for the monorepo shape: root `apps/reserve/`,
      build `turbo build --filter=@repo/reserve`, install `npm ci` at the
      repo root.
- [ ] Vercel function region set to match Supabase (us-west-2).
- [ ] NUXT_ASK_DATABASE_URL set to the pooler DSN (6543, tx mode), pg client
      configured for serverless; verified no connection-climb under a
      burst of ask queries.
- [ ] All env vars above set in PRODUCTION with prod values; preview env
      set with non-prod (test Stripe, empty/non-prod leads, test pepper).
- [ ] Preview deployments OFF in Vercel until the staging Supabase project
      exists; when it does, the preview environment carries that
      project's URL and keys and never production's (decision 3).
- [ ] Stripe: live keys swapped in; prod webhook endpoint registered at
      the prod URL in the Stripe dashboard; its signing secret set as
      NUXT_STRIPE_WEBHOOK_SECRET (prod env only); webhook route reachable,
      NOT behind preview protection; a small real-money verification pass.
- [ ] DB password rotated BEFORE this deploy (chat-exposed, and echoed by a
      failing script on 2026-10-05); then TBLS_DSN and the ask DSN updated.
- [ ] Resend key rotated (chat-exposed; per pre-launch list)
      and MAIL_FROM's domain verified in Resend.
- [ ] NUXT_FORM_IP_PEPPER set to a fresh prod-specific value.
- [ ] NUXT_LEADS_ORGANIZATION_ID and NUXT_LEADS_ALLOWED_ORIGINS set to real values
      (origin = the deployed marketing site).
- [ ] Node version: Vercel uses .nvmrc (22.22.2) or project setting;
      postinstall (nuxt prepare) runs in the Vercel build.
- [ ] Build command is `turbo build --filter=@repo/reserve` only — does not
      invoke harnesses. Secrets need not be present at build (nothing is
      baked; `verify:build-secrets` proves it on every CI run).
- [ ] CI gate green on the deploying commit (it already gates PRs; confirm
      main is green before promoting a deploy).
- [ ] Schema drift check: `npm run schema:compare` (hosted versus a local
      stack rebuilt from the migrations) at ZERO differences — tables,
      constraints, indexes, policies, triggers with their enabled state,
      functions, views by definition and options (`security_invoker` on
      `ledger_lines` and `ledger_transactions` especially), grants,
      default privileges, cron, publication. Before 2026-10-08 the
      comparison was run by hand after each push and did not cover view
      definitions; the two functions and the trigger that once reached
      hosted outside a migration are what this gate exists for.

After deploy, verify (the effect, both directions, per the house style):
- [ ] A page loads; a service-role route works on the prod secret key.
- [ ] Ask queries run without connection-limit errors under a burst.
- [ ] A test lead POST from the real marketing origin succeeds; from a
      disallowed origin is refused (CORS holds in prod).
- [ ] A public form submit works; the honeypot and rate limit hold.
- [ ] A real Stripe payment + its webhook reconcile (small real-money pass).
- [ ] pg_cron purges still run (they're in Supabase, unaffected by deploy —
      the verify:forms/leads outcome canaries still pass).

## Deferred / later shape

- ~~Dedicated CI Supabase project so the verify:* harnesses can run in CI~~
  Done the other way (2026-10-05, docs/testing-design.md): the CI
  `database` and `e2e` jobs start a LOCAL Supabase stack in the runner,
  rebuild it from the migrations and run every harness and the journeys
  against it. No second hosted project; nothing that writes into an
  append-only table ever runs against hosted.
- require-approvals on branch protection when the backend engineer joins.
  The repository lives in the GitHub organisation since 2026-10-08
  (`github.com/the-reserve-app/the-reserve`); Vercel's Git integration
  points at that address.

## Relationship to other docs

- architecture.md — the doors; the public endpoints (Door 0 and lead
  capture) are the ones whose prod reachability + CORS matter here.
- The pre-launch list in TODO.md — its Stripe, Resend/DB-rotation and
  FORM_IP_PEPPER items are pointers to this doc (one fact, one place);
  this doc is the authoritative deployment shape and env matrix.
- ASK_DATABASE_URL / ask_readonly — the pooler decision is the deployment
  half of the ask boundary; the session-user-is-the-leash design is
  unaffected (pooler still connects as ask_readonly).
