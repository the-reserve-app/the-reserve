# The demo — The Reserve as if it had run since January of last year

A believable spa on the LOCAL stack: ten staff with roles, titles and
weekly hours; a menu of massages, facials and body treatments; a retail
range with a few items low or out of stock; some four hundred fictional
clients with regulars, occasional visitors and one-timers; appointments
from January 1 of last year to today with a weekly rhythm (Saturdays
busiest), growth over the span and seasonal bumps (the December run-up,
Valentine's week, Mother's Day week), with cancellations, no-shows and
late-cancellation fees; every sale balanced through the ledger's own
checks (services, retail with tax, tips, discounts, gift cards sold and
redeemed, a handful of refunds); the next four weeks booked; and one demo
owner login. Because the history covers all of last year, the year view's
comparison with last year means something.

Local only, by construction: `scripts/seed-demo.mjs` calls
`requireLocalStack()` and refuses anything else. The hosted ledger and
audit log are append-only for every role, so demo rows there could never
be removed.

Loading takes about 16 seconds on a laptop (12,600 appointments and
12,300 sales); removing it takes a few seconds.

## The steps, in order

Every command runs from the repository root, in one terminal, so the
exported settings carry from step to step.

### 1. Start Docker and the local stack

Open Docker Desktop and wait until it says it is running. Then:

```bash
npx supabase start
```

If the stack was already running this prints its status and returns. Then
point the harness scripts at it:

```bash
eval "$(npx supabase status -o env | sed -E 's/^([A-Z_0-9]+)="(.*)"$/\1=\2/' | sed 's/^/export /')" && export SUPABASE_LOCAL=true DATABASE_URL="$DB_URL"
```

### 2. Load the demo

```bash
npm run seed:demo
```

It prints the demo owner's email and password to the terminal and nowhere
else (not to any file; the manifest in `node_modules/.cache/demo-seed.json`
holds only ids). Keep that terminal open, or copy the two lines somewhere
private: the password is not recoverable. The seed refuses to run twice;
remove the demo first (step 6) to load it again, which prints a new
password.

### 3. Start the app against the local stack

The built app, on its own port (3300), reads the local stack from the
settings exported in step 1. The dev server on 3000 keeps pointing
wherever your `.env` points, so there is nothing to switch back
afterwards.

For Ask The Reserve to answer, export its two settings first. The Ask
connection is the local `ask_readonly` role; give it a password once on
the local stack (any value, it is local only):

```bash
psql "$DATABASE_URL" -c "alter role ask_readonly with password 'local-ask'"
```

```bash
export NUXT_ANTHROPIC_API_KEY="<your Anthropic key>" NUXT_ASK_DATABASE_URL="postgresql://ask_readonly:local-ask@127.0.0.1:54322/postgres"
```

Then build and start:

```bash
npm run build:check && npm run app:start
```

The build takes a minute or two; the starter reports "The app is up on
http://localhost:3300".

### 4. Sign in

Open http://localhost:3300 and sign in with the email and password from
step 2. The demo owner has every permission, so the dashboard, schedule,
clients, financials (month and year), Ask and the settings pages are all
reachable. If the browser still holds a session from an earlier demo
login, sign out first: the earlier user no longer exists.

### 5. Stop the app

```bash
npm run app:stop
```

### 6. Remove the demo

```bash
npm run seed:demo -- --clean
```

Removes everything the demo created — the ledger and audit rows on the
direct connection in replica mode, local only — restores the location's
tax rate and hours, deletes the demo login, and then proves nothing is
left (every marker and every manifest id counted at zero, no orphan
appointment or ledger lines). The other way back is a full rebuild from
the migrations, which also removes everything:

```bash
npx supabase db reset --local
```

To stop the stack afterwards: `npx supabase stop`.

## How the money was written

A history of back-dated sales needs a `created_at` in the past, and
`write_ledger_transaction` takes none by design. The history is
therefore inserted on the direct connection with every ledger trigger
ACTIVE, each sale in its own transaction: balanced at commit by
`assert_ledger_transaction`, line arithmetic checked, one refund per
original, gift-card balances and product stock moved by their triggers.
Today's sales go through `write_ledger_transaction`, the app's own path.
Nothing is bypassed in either direction; the only replica-mode statement
is the cleanup.
