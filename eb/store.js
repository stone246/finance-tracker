// eb/store.js — persistence for the Enable Banking integration.
//
// - Adds a nullable `external_id` column (+ partial unique index) to the
//   existing `entries` table so imported bank transactions can be de-duped
//   on re-import. No other change to the entries schema; existing code and
//   tests are unaffected (the column is nullable and never read by db.js).
// - Adds sidecar tables (eb_*) in the same finance.db for data that is not
//   a ledger movement: sessions, discovered accounts, balance snapshots,
//   auth state (CSRF), and a sync log.
//
// Everything here is READ-ONLY with respect to the bank: it only writes to
// the local database.

import { createHash } from 'node:crypto';
import { today } from '../dates.js';

const EB_SCHEMA = `
CREATE TABLE IF NOT EXISTS eb_auth_state (
  state            TEXT PRIMARY KEY,
  authorization_id TEXT,
  created_at       TEXT NOT NULL,
  consumed_at      TEXT
);

CREATE TABLE IF NOT EXISTS eb_sessions (
  session_id    TEXT PRIMARY KEY,
  aspsp_name    TEXT,
  aspsp_country TEXT,
  psu_type      TEXT,
  valid_until   TEXT,
  created_at    TEXT NOT NULL,
  raw           TEXT
);

CREATE TABLE IF NOT EXISTS eb_accounts (
  uid                 TEXT PRIMARY KEY,
  session_id          TEXT,
  name                TEXT,
  product             TEXT,
  iban                TEXT,
  currency            TEXT,
  cash_account_type   TEXT,
  usage               TEXT,
  identification_hash TEXT,
  entries_account     TEXT,
  details_json        TEXT,
  first_seen_at       TEXT NOT NULL,
  last_synced_at      TEXT
);

CREATE TABLE IF NOT EXISTS eb_balances (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_uid    TEXT NOT NULL,
  balance_type   TEXT,
  amount         REAL NOT NULL,
  currency       TEXT,
  reference_date TEXT,
  captured_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eb_sync_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  account_uid      TEXT NOT NULL,
  ran_at           TEXT NOT NULL,
  tx_from          TEXT,
  tx_to            TEXT,
  fetched          INTEGER,
  inserted         INTEGER,
  skipped          INTEGER,
  balance_amount   REAL,
  balance_currency TEXT,
  note             TEXT
);

CREATE INDEX IF NOT EXISTS idx_eb_balances_acct ON eb_balances(account_uid);
CREATE INDEX IF NOT EXISTS idx_eb_sync_acct ON eb_sync_log(account_uid);
`;

const eur = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const nowIso = () => new Date().toISOString();

// Bring an existing finance.db up to date for the EB integration.
export function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(entries)').all().map((c) => c.name);
  if (!cols.includes('external_id')) {
    db.exec('ALTER TABLE entries ADD COLUMN external_id TEXT');
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_external_id
       ON entries(external_id) WHERE external_id IS NOT NULL`
  );
  db.exec(EB_SCHEMA);
}

// ---- auth state (CSRF) --------------------------------------------------

export function saveAuthState(db, { state, authorizationId }) {
  db.prepare(
    `INSERT INTO eb_auth_state (state, authorization_id, created_at)
     VALUES (?, ?, ?)`
  ).run(state, authorizationId ?? null, nowIso());
}

// Returns the row if `state` is known and unused, and marks it consumed.
// Returns null otherwise (unknown or replayed).
export function consumeAuthState(db, state) {
  const row = db
    .prepare('SELECT * FROM eb_auth_state WHERE state = ?')
    .get(state);
  if (!row || row.consumed_at) return null;
  db.prepare('UPDATE eb_auth_state SET consumed_at = ? WHERE state = ?').run(
    nowIso(),
    state
  );
  return row;
}

// ---- sessions & accounts ---------------------------------------------------

export function saveSession(db, session) {
  db.prepare(
    `INSERT INTO eb_sessions
       (session_id, aspsp_name, aspsp_country, psu_type, valid_until, created_at, raw)
     VALUES (:session_id, :aspsp_name, :aspsp_country, :psu_type, :valid_until, :created_at, :raw)
     ON CONFLICT(session_id) DO UPDATE SET
       valid_until = excluded.valid_until, raw = excluded.raw`
  ).run({
    session_id: session.session_id,
    aspsp_name: session.aspsp?.name ?? null,
    aspsp_country: session.aspsp?.country ?? null,
    psu_type: session.psu_type ?? null,
    valid_until: session.access?.valid_until ?? null,
    created_at: nowIso(),
    raw: JSON.stringify(session),
  });
}

export function upsertAccount(db, { account, sessionId, entriesAccount, details }) {
  const iban =
    account.account_id?.iban ?? account.account_id?.other?.identification ?? null;
  db.prepare(
    `INSERT INTO eb_accounts
       (uid, session_id, name, product, iban, currency, cash_account_type,
        usage, identification_hash, entries_account, details_json, first_seen_at)
     VALUES
       (:uid, :session_id, :name, :product, :iban, :currency, :cash_account_type,
        :usage, :identification_hash, :entries_account, :details_json, :first_seen_at)
     ON CONFLICT(uid) DO UPDATE SET
       session_id = excluded.session_id,
       name = COALESCE(excluded.name, eb_accounts.name),
       product = COALESCE(excluded.product, eb_accounts.product),
       iban = COALESCE(excluded.iban, eb_accounts.iban),
       currency = COALESCE(excluded.currency, eb_accounts.currency),
       cash_account_type = COALESCE(excluded.cash_account_type, eb_accounts.cash_account_type),
       usage = COALESCE(excluded.usage, eb_accounts.usage),
       identification_hash = COALESCE(excluded.identification_hash, eb_accounts.identification_hash),
       details_json = COALESCE(excluded.details_json, eb_accounts.details_json)`
  ).run({
    uid: account.uid,
    session_id: sessionId ?? null,
    name: account.name ?? details?.name ?? null,
    product: account.product ?? details?.product ?? null,
    iban,
    currency: account.currency ?? details?.currency ?? null,
    cash_account_type: account.cash_account_type ?? null,
    usage: account.usage ?? null,
    identification_hash: account.identification_hash ?? null,
    entries_account: entriesAccount ?? null,
    details_json: details ? JSON.stringify(details) : null,
    first_seen_at: nowIso(),
  });
}

export function markAccountSynced(db, uid) {
  db.prepare('UPDATE eb_accounts SET last_synced_at = ? WHERE uid = ?').run(
    nowIso(),
    uid
  );
}

export function listAccounts(db) {
  return db.prepare('SELECT * FROM eb_accounts ORDER BY first_seen_at').all();
}

// ---- balances -----------------------------------------------------------

// Store one snapshot row per balance returned. Keeps history.
export function saveBalances(db, accountUid, balances = []) {
  const stmt = db.prepare(
    `INSERT INTO eb_balances
       (account_uid, balance_type, amount, currency, reference_date, captured_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const captured = nowIso();
  const saved = [];
  for (const b of balances) {
    const amount = eur(b.balance_amount?.amount ?? b.amount ?? 0);
    const currency = b.balance_amount?.currency ?? b.currency ?? null;
    stmt.run(
      accountUid,
      b.balance_type ?? null,
      amount,
      currency,
      b.reference_date ?? b.last_change_date_time ?? null,
      captured
    );
    saved.push({ balance_type: b.balance_type ?? null, amount, currency });
  }
  return saved;
}

// The balance most useful as "the number": prefer a closing/available type.
export function pickHeadlineBalance(balances = []) {
  const order = ['CLBD', 'XPCD', 'ITAV', 'PRCD', 'OTHR'];
  const byType = (t) =>
    balances.find((b) => (b.balance_type ?? '').toUpperCase() === t);
  for (const t of order) {
    const hit = byType(t);
    if (hit) return hit;
  }
  return balances[0] ?? null;
}

// ---- transactions -> entries -----------------------------------------------

function hashTxn(t) {
  return createHash('sha1').update(JSON.stringify(t)).digest('hex').slice(0, 16);
}

// Map one Enable Banking transaction to an `entries` row that satisfies the
// existing CHECK constraints.
export function transactionToEntry(accountUid, t, entriesAccount = 'Bank') {
  const raw = Number(t?.transaction_amount?.amount ?? 0);
  const amount = Math.abs(eur(Number.isFinite(raw) ? raw : 0));
  const isCredit = String(t?.credit_debit_indicator).toUpperCase() === 'CRDT';
  const type = isCredit ? 'income' : 'expense';
  const date =
    t?.booking_date || t?.value_date || t?.transaction_date || today();

  const remittance = Array.isArray(t?.remittance_information)
    ? t.remittance_information.join(' ').trim()
    : String(t?.remittance_information || '').trim();
  const counterparty = isCredit
    ? t?.debtor?.name || t?.debtor_account?.iban
    : t?.creditor?.name || t?.creditor_account?.iban;
  const title = String(
    counterparty || remittance || (isCredit ? 'Incoming transfer' : 'Payment')
  ).slice(0, 140);

  const detailBits = [];
  if (remittance && remittance !== title) detailBits.push(remittance);
  if (t?.bank_transaction_code?.description)
    detailBits.push(t.bank_transaction_code.description);
  if (t?.status) detailBits.push(`status:${t.status}`);
  const detail = detailBits.join(' · ').slice(0, 500) || null;

  // expense category must be Savings|Investments|Discretionary; income stays null
  const category = type === 'expense' ? 'Discretionary' : null;

  const ref = t?.entry_reference || t?.transaction_id || hashTxn(t);
  const external_id = `eb:${accountUid}:${ref}`;

  return { external_id, amount, type, date, account: entriesAccount, category, title, detail };
}

// Insert mapped rows into `entries`, skipping any external_id already present.
// Returns { fetched, inserted, skipped, rows }.
export function importTransactions(db, accountUid, transactions, entriesAccount = 'Bank') {
  const mapped = transactions.map((t) =>
    transactionToEntry(accountUid, t, entriesAccount)
  );
  const existsStmt = db.prepare(
    'SELECT 1 FROM entries WHERE external_id = ? LIMIT 1'
  );
  const insertStmt = db.prepare(
    `INSERT INTO entries
       (amount, type, date, account, category, title, detail,
        is_recurring, recurring_id, created_at, external_id)
     VALUES
       (:amount, :type, :date, :account, :category, :title, :detail,
        0, NULL, :created_at, :external_id)`
  );

  let inserted = 0;
  let skipped = 0;
  const rows = [];
  db.exec('BEGIN');
  try {
    for (const row of mapped) {
      if (existsStmt.get(row.external_id)) {
        skipped++;
        continue;
      }
      insertStmt.run({ ...row, created_at: nowIso() });
      inserted++;
      rows.push(row);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { fetched: transactions.length, inserted, skipped, rows };
}

export function logSync(db, entry) {
  db.prepare(
    `INSERT INTO eb_sync_log
       (account_uid, ran_at, tx_from, tx_to, fetched, inserted, skipped,
        balance_amount, balance_currency, note)
     VALUES
       (:account_uid, :ran_at, :tx_from, :tx_to, :fetched, :inserted, :skipped,
        :balance_amount, :balance_currency, :note)`
  ).run({
    account_uid: entry.account_uid,
    ran_at: nowIso(),
    tx_from: entry.tx_from ?? null,
    tx_to: entry.tx_to ?? null,
    fetched: entry.fetched ?? null,
    inserted: entry.inserted ?? null,
    skipped: entry.skipped ?? null,
    balance_amount: entry.balance_amount ?? null,
    balance_currency: entry.balance_currency ?? null,
    note: entry.note ?? null,
  });
}

export function recentSyncLog(db, limit = 20) {
  return db
    .prepare('SELECT * FROM eb_sync_log ORDER BY id DESC LIMIT ?')
    .all(limit);
}

// One row per account: from that account's most recent capture batch, the
// balance whose type ranks highest (closing booked > expected > available > …).
export function latestBalances(db) {
  const rows = db
    .prepare(
      `SELECT b.* FROM eb_balances b
        JOIN (SELECT account_uid, MAX(captured_at) AS c
                FROM eb_balances GROUP BY account_uid) m
          ON b.account_uid = m.account_uid AND b.captured_at = m.c`
    )
    .all();
  const rank = (t) => {
    const i = ['CLBD', 'XPCD', 'ITAV', 'PRCD', 'OTHR'].indexOf(
      String(t || '').toUpperCase()
    );
    return i === -1 ? 99 : i;
  };
  const best = new Map();
  for (const r of rows) {
    const cur = best.get(r.account_uid);
    if (!cur || rank(r.balance_type) < rank(cur.balance_type)) {
      best.set(r.account_uid, r);
    }
  }
  return [...best.values()];
}
