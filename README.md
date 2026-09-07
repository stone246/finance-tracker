# Finance Tracker

Local-first personal finance tracker. Everything in EUR. No dependencies — just
Node's built-in HTTP server and `node:sqlite`.

## Run

```
cd finance-tracker
npm start
```

Then open <http://127.0.0.1:3000>. The SQLite file `finance.db` is created next to
`server.js` on first run.

Config via env vars: `PORT` (default 3000), `HOST` (default `127.0.0.1`),
`DB_PATH` (default `./finance.db`).

> Bind stays on localhost. When you later put this behind Tailscale, set
> `HOST=0.0.0.0` (or the Tailscale IP) — no other change needed.

### Demo data (optional)

```
node seed-demo.js        # fills the DB with sample entries + recurring rules
```

To start empty again, stop the server and delete `finance.db` (plus `-wal` / `-shm`).

### Fonts

Inter + Space Grotesk are self-hosted in `public/fonts/` (`.woff2`), so the UI
renders identically offline / over Tailscale. No external font requests.

## Test

```
npm test        # node --test — data layer: schema, add/edit/delete,
                # recurring generation, catch-up watermark, dashboard maths
```

## Data model

**`entries`** — the ledger. `id, amount, type (income|expense), date, account
(Cash|Revolut|Bank), category (Savings|Investments|Discretionary|Income|null),
title, detail, is_recurring, recurring_id, created_at, external_id`. Income
entries may leave `category` blank or set it to `Income`. `external_id` is
`NULL` for entries you add by hand; the Enable Banking import (see below) sets
it to a stable per-transaction key so re-imports don't duplicate rows.

**`recurring_rules`** — templates for repeating entries. `amount, type, account,
category, title, detail, interval (weekly|monthly|yearly), start_date,
last_generated, active, created_at`.

Creating a rule immediately logs its first entry (on `start_date`) and sets
`last_generated` to that date.

## Recurring catch-up

On page load the app asks the server which occurrences have come due since each
rule's `last_generated` watermark, up to today, and shows a confirmation dialog.
Ticked dates are logged; the watermark then advances past **every** date that was
offered, so unticked dates are treated as a deliberate skip and won't be asked
again. "Not now" leaves the watermark untouched — you'll be asked next time.

## Dashboard

- **Week** = Monday 00:00 → now. **Month** = 1st → now. **Year** = Jan 1 → now.
- Comparison is period-to-date vs the *same span* of the previous period
  (last week = the matching Mon–weekday window; last month = the same day-of-month
  range; last year = the same calendar span), so an in-progress period is compared
  fairly. Shown as an absolute EUR delta and a percentage next to each figure
  (percentages past ±1000 % — only seen against a near-empty baseline — collapse to
  `>+999%`).
- Category split (Savings / Investments / Discretionary) and per-account flow are
  shown as bars **with** the numbers.
- All-time balance and per-account balances are always in the header.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/entries?from&to&type&account&category&recurringOnly&limit` | list |
| POST | `/api/entries` | create |
| GET | `/api/entries/:id` | fetch one |
| PATCH | `/api/entries/:id` | partial update |
| DELETE | `/api/entries/:id` | delete |
| GET | `/api/recurring` | list rules (with `next_due`, `monthly_equivalent`) |
| POST | `/api/recurring` | create rule + first entry |
| PATCH | `/api/recurring/:id` | update rule |
| DELETE | `/api/recurring/:id` | delete rule (logged entries stay, unlinked) |
| GET | `/api/recurring/due?ref=YYYY-MM-DD` | occurrences awaiting confirmation |
| POST | `/api/recurring/materialize` | `{ selections: [{rule_id, date}], ref? }` |
| GET | `/api/summary?ref=YYYY-MM-DD` | dashboard figures (all-time, week, month, year) |

## Bank import (Enable Banking)

Optional **read-only** pull of real account details, balances and transactions
from a bank, via Enable Banking. Currently in **Sandbox** mode against the
**Mock ASPSP** (fake test data). Account Information only — no payments, ever.

Start the server and open <http://127.0.0.1:3000/eb>, click **Connect sandbox
bank**, approve the consent, and you land back on `/callback` with balances and
transactions stored. Imported transactions appear in the normal ledger
(`account = Bank`); balances live in `eb_balances`. Full detail in
[`eb/README.md`](eb/README.md).

## UI

Single page, dark royal-blue glass theme. Top bar (**Add Entry** opens the log
modal, **View Entries** / **Monthly** switch the main area, "Welcome Cian" returns
to the dashboard). Current balance + per-account balances always on top. Numbers
count to their new value, cards reveal on load, the Week/Month/Year control slides,
and charts grow in — all disabled under `prefers-reduced-motion`.

## Files

```
server.js         HTTP server: JSON API + static file serving
db.js             schema + every data operation (shared by server and tests)
dates.js          pure date maths (week/month/year boundaries, recurrence)
test/db.test.js   node:test suite for the data layer
test/eb.test.js   node:test suite for the Enable Banking layer
seed-demo.js      optional sample-data loader
public/           index.html, styles.css, app.js, fonts/
eb/               Enable Banking integration (read-only AIS) — see eb/README.md
secrets/          private key (git-ignored)
```
