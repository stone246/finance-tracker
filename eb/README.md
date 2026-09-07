# Enable Banking integration

Pulls account details, balances and transactions from a bank via
[Enable Banking](https://enablebanking.com) and writes them into `finance.db`.

**Read-only, permanently.** This integration uses **Account Information
Services (AIS)** only. It never initiates payments: there are no
payment/payment-initiation calls anywhere in this folder, and `eb/client.js`
throws if any code path ever asks the API for a `payment` endpoint. Adding
payment functionality is a deliberate decision to be confirmed with the
account owner first — do not add it silently.

Currently pointed at the **Sandbox** environment and Enable Banking's
**Mock ASPSP** (fake test data). No real accounts are touched.

## Setup

The private key lives at `secrets/694ed911-3539-43f8-a464-14c6692835c9.pem`
(the whole `secrets/` folder is git-ignored). Nothing else is required —
`eb/config.js` has working sandbox defaults. Override with env vars if needed:

| Env var | Default | Meaning |
| --- | --- | --- |
| `EB_APPLICATION_ID` | `694ed911-…835c9` | Enable Banking application id (JWT `kid`) |
| `EB_PRIVATE_KEY_PATH` | `secrets/694ed911-…835c9.pem` | RSA private key (PEM) |
| `EB_API_BASE` | `https://api.enablebanking.com` | API host |
| `EB_ASPSP_NAME` / `EB_ASPSP_COUNTRY` | `Mock ASPSP` / `FI` | target bank |
| `EB_REDIRECT_URL` | `http://localhost:3000/callback` | must match a URL registered on the app |
| `EB_TX_SINCE_DAYS` | `90` | how far back to import transactions |
| `EB_CONSENT_DAYS` | `10` | consent validity requested |
| `EB_ENTRIES_ACCOUNT` | `Bank` | the `entries.account` label used for imported rows |

## Flow

```
GET /eb                -> status page (accounts, balances, sync log) + buttons
GET /eb/connect        -> POST /auth, then 302 to the bank consent page
   (user approves the consent in the browser)
GET /callback?code=&state=
                       -> POST /sessions with the code, then for every account:
                          GET /accounts/{uid}/details
                          GET /accounts/{uid}/balances
                          GET /accounts/{uid}/transactions   (paged)
                          -> store, then 302 back to /eb
GET /eb/refresh        -> re-pull balances + transactions for the last session
GET /eb/status         -> same data as JSON
GET /eb/aspsps?country=FI&q=mock   -> ASPSP list (debug)
GET /eb/application    -> application metadata incl. registered redirect URLs
```

`state` is a random UUID stored in `eb_auth_state` when the consent starts and
consumed once at `/callback`; an unknown or replayed `state` is rejected.

### Same thing from the terminal

```
node eb/cli.js application
node eb/cli.js aspsps FI mock
node eb/cli.js auth                         # prints the consent URL
node eb/cli.js callback "<redirect URL you land on>"
node eb/cli.js refresh <session_id>
```

## Authentication

`eb/jwt.js` builds an RS256 JWT with `node:crypto` only:

- header `{ typ: "JWT", alg: "RS256", kid: <application id> }`
- payload `{ iss: "enablebanking.com", aud: "api.enablebanking.com", iat, exp }`
- `exp - iat` capped at 86400 s; re-signed ~1 min before expiry
- sent as `Authorization: Bearer <jwt>`

## Storage

`eb/store.js` owns all writes. It adds one nullable column to the existing
ledger and a few sidecar tables — nothing existing changes shape.

**`entries`** — gains `external_id TEXT` (nullable) + a partial unique index.
Imported transactions map to:

| entries column | from the Enable Banking transaction |
| --- | --- |
| `external_id` | `eb:{account_uid}:{entry_reference \|\| transaction_id \|\| sha1(txn)}` |
| `amount` | `abs(transaction_amount.amount)` |
| `type` | `credit_debit_indicator == "CRDT"` → `income`, else `expense` |
| `date` | `booking_date \|\| value_date \|\| transaction_date` |
| `account` | `EB_ENTRIES_ACCOUNT` (`Bank`) |
| `category` | `expense` → `Discretionary`; `income` → `NULL` |
| `title` | counterparty name, else remittance text |
| `detail` | remittance + bank transaction code + status |
| `is_recurring` / `recurring_id` | `0` / `NULL` |

Re-imports are de-duped on `external_id`: already-seen transactions are
skipped, new ones inserted.

**`eb_accounts`** — one row per discovered account (uid, iban, name, currency,
which `entries.account` label it maps to, full details JSON).
**`eb_balances`** — one snapshot row per balance per sync (keeps history).
**`eb_sessions`** — Enable Banking sessions created at `/callback`.
**`eb_auth_state`** — CSRF `state` values, created at `/connect`, consumed at `/callback`.
**`eb_sync_log`** — one row per account per sync: counts + balance seen.

Balances are **not** written to `entries` — a balance is a position, not a
ledger movement. Read them from `eb_balances` / `/eb/status`.

## Files

```
eb/config.js    settings + the read-only guard (assertReadOnlyPath)
eb/jwt.js       RS256 JWT, node:crypto only
eb/client.js    fetch wrapper + typed AIS helpers (no payment helpers)
eb/store.js     entries migration + eb_* schema + all writes + txn mapping
eb/flow.js      begin auth / complete callback / sync account / refresh
eb/routes.js    HTTP routes (/eb, /eb/*, /callback)
eb/cli.js       the same flow from the terminal
test/eb.test.js offline tests: JWT, mapping, de-dupe, migration
```
