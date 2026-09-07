// test/eb.test.js — Enable Banking integration, offline unit tests.
// No network: covers JWT signing, transaction->entry mapping, de-dupe on
// re-import, and the entries migration (idempotent, backward compatible).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { openDb } from '../db.js';
import { EB, assertReadOnlyPath } from '../eb/config.js';
import { signJwt } from '../eb/jwt.js';
import {
  migrate,
  transactionToEntry,
  importTransactions,
  saveBalances,
  pickHeadlineBalance,
} from '../eb/store.js';

const b64urlToBuf = (s) =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

test('signJwt: RS256 header, correct claims, <=24h, verifiable signature', () => {
  const { token } = signJwt({ now: 1_700_000_000 });
  const [h, p, sig] = token.split('.');
  assert.equal(token.split('.').length, 3);

  const header = JSON.parse(b64urlToBuf(h).toString('utf8'));
  assert.deepEqual(header, {
    typ: 'JWT',
    alg: 'RS256',
    kid: EB.applicationId,
  });

  const payload = JSON.parse(b64urlToBuf(p).toString('utf8'));
  assert.equal(payload.iss, 'enablebanking.com');
  assert.equal(payload.aud, 'api.enablebanking.com');
  assert.equal(payload.iat, 1_700_000_000);
  assert.ok(payload.exp - payload.iat <= 86400);
  assert.ok(payload.exp > payload.iat);

  const pub = createPublicKey(readFileSync(EB.privateKeyPath, 'utf8'));
  const ok = createVerify('RSA-SHA256')
    .update(`${h}.${p}`)
    .verify(pub, b64urlToBuf(sig));
  assert.ok(ok, 'signature must verify against the key pair');
});

test('assertReadOnlyPath: rejects any payments path', () => {
  assert.throws(() => assertReadOnlyPath('/payments'));
  assert.throws(() => assertReadOnlyPath('/payment-initiation/foo'));
  assert.doesNotThrow(() => assertReadOnlyPath('/accounts/x/transactions'));
});

test('transactionToEntry: debit -> expense/Discretionary, credit -> income/null', () => {
  const debit = transactionToEntry(
    'acc-1',
    {
      transaction_amount: { amount: '-12.34', currency: 'EUR' },
      credit_debit_indicator: 'DBDT',
      booking_date: '2026-08-15',
      creditor: { name: 'Coffee Bar' },
      remittance_information: ['Flat white'],
      entry_reference: 'ref-abc',
    },
    'Bank'
  );
  assert.deepEqual(debit, {
    external_id: 'eb:acc-1:ref-abc',
    amount: 12.34,
    type: 'expense',
    date: '2026-08-15',
    account: 'Bank',
    category: 'Discretionary',
    title: 'Coffee Bar',
    detail: 'Flat white',
  });

  const credit = transactionToEntry(
    'acc-1',
    {
      transaction_amount: { amount: '2650.00', currency: 'EUR' },
      credit_debit_indicator: 'CRDT',
      booking_date: '2026-08-01',
      debtor: { name: 'ACME Payroll' },
      transaction_id: 'tx-9',
    },
    'Bank'
  );
  assert.equal(credit.type, 'income');
  assert.equal(credit.category, null);
  assert.equal(credit.amount, 2650);
  assert.equal(credit.title, 'ACME Payroll');
  assert.equal(credit.external_id, 'eb:acc-1:tx-9');
});

test('transactionToEntry: no reference -> stable content hash id', () => {
  const t = {
    transaction_amount: { amount: '-5.00' },
    credit_debit_indicator: 'DBDT',
    booking_date: '2026-08-10',
  };
  const a = transactionToEntry('acc-1', t, 'Bank');
  const b = transactionToEntry('acc-1', t, 'Bank');
  assert.equal(a.external_id, b.external_id);
  assert.match(a.external_id, /^eb:acc-1:[0-9a-f]{16}$/);
});

test('migrate: idempotent and backward compatible with db.js', () => {
  const db = openDb(':memory:');
  migrate(db.raw);
  migrate(db.raw); // twice must not throw

  const cols = db.raw
    .prepare('PRAGMA table_info(entries)')
    .all()
    .map((c) => c.name);
  assert.ok(cols.includes('external_id'));

  // existing data layer keeps working, external_id defaults to NULL
  const e = db.createEntry({
    amount: 10,
    type: 'expense',
    date: '2026-08-01',
    account: 'Cash',
    category: 'Discretionary',
    title: 'manual',
  });
  const back = db.raw
    .prepare('SELECT external_id FROM entries WHERE id = ?')
    .get(e.id);
  assert.equal(back.external_id, null);
  db.close();
});

test('importTransactions: inserts once, skips duplicates on re-run', () => {
  const db = openDb(':memory:');
  migrate(db.raw);

  const txns = [
    {
      transaction_amount: { amount: '-20.00', currency: 'EUR' },
      credit_debit_indicator: 'DBDT',
      booking_date: '2026-08-20',
      creditor: { name: 'Shop A' },
      entry_reference: 'r1',
    },
    {
      transaction_amount: { amount: '100.00', currency: 'EUR' },
      credit_debit_indicator: 'CRDT',
      booking_date: '2026-08-21',
      debtor: { name: 'Refund Co' },
      entry_reference: 'r2',
    },
  ];

  const first = importTransactions(db.raw, 'acc-9', txns, 'Bank');
  assert.equal(first.inserted, 2);
  assert.equal(first.skipped, 0);

  const second = importTransactions(db.raw, 'acc-9', txns, 'Bank');
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped, 2);

  // a new transaction alongside the seen ones: only the new one lands
  const third = importTransactions(
    db.raw,
    'acc-9',
    [
      ...txns,
      {
        transaction_amount: { amount: '-3.50' },
        credit_debit_indicator: 'DBDT',
        booking_date: '2026-08-22',
        entry_reference: 'r3',
      },
    ],
    'Bank'
  );
  assert.equal(third.inserted, 1);
  assert.equal(third.skipped, 2);

  const rows = db.listEntries();
  assert.equal(rows.length, 3);
  // mapped rows satisfy the entries CHECK constraints (insert would throw otherwise)
  for (const r of rows) {
    assert.ok(['Cash', 'Revolut', 'Bank'].includes(r.account));
    assert.ok(r.amount >= 0);
    if (r.type === 'expense') {
      assert.ok(['Savings', 'Investments', 'Discretionary'].includes(r.category));
    }
  }
  db.close();
});

test('saveBalances + pickHeadlineBalance: snapshot rows and headline pick', () => {
  const db = openDb(':memory:');
  migrate(db.raw);
  const balances = [
    { balance_amount: { amount: '1234.56', currency: 'EUR' }, balance_type: 'CLBD', reference_date: '2026-09-01' },
    { balance_amount: { amount: '1200.00', currency: 'EUR' }, balance_type: 'XPCD', reference_date: '2026-09-01' },
  ];
  const saved = saveBalances(db.raw, 'acc-b', balances);
  assert.equal(saved.length, 2);
  const n = db.raw.prepare('SELECT COUNT(*) c FROM eb_balances WHERE account_uid = ?').get('acc-b').c;
  assert.equal(n, 2);
  assert.equal(pickHeadlineBalance(balances).balance_type, 'CLBD');
  db.close();
});
