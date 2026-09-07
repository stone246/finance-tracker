// Run with:  node --test
// Verifies the data layer before any UI exists (schema, add/edit/delete,
// recurring generation, catch-up watermark, dashboard aggregation).

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { addMonths, addYears, startOfWeekMonday, occurrencesBetween } from '../dates.js';

function freshDb() {
  return openDb(':memory:');
}

// ---------------------------------------------------------------- date math

test('addMonths clamps to end of month', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-01-31', 2), '2026-03-31');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29'); // leap year
});

test('addYears clamps Feb 29', () => {
  assert.equal(addYears('2024-02-29', 1), '2025-02-28');
  assert.equal(addYears('2024-02-29', 4), '2028-02-29');
});

test('startOfWeekMonday', () => {
  assert.equal(startOfWeekMonday('2026-09-01'), '2026-08-31'); // Tue -> Mon
  assert.equal(startOfWeekMonday('2026-08-31'), '2026-08-31'); // Mon -> same
  assert.equal(startOfWeekMonday('2026-09-06'), '2026-08-31'); // Sun -> Mon
});

test('occurrencesBetween is inclusive of the through date and exclusive of "after"', () => {
  const occ = occurrencesBetween('2026-01-01', 'monthly', '2026-03-01', '2026-06-01');
  assert.deepEqual(occ, ['2026-04-01', '2026-05-01', '2026-06-01']);
});

// ---------------------------------------------------------------- entries CRUD

test('createEntry saves and reads back correctly', () => {
  const db = freshDb();
  const e = db.createEntry({
    amount: 12.5,
    type: 'expense',
    date: '2026-09-01',
    account: 'Revolut',
    category: 'Discretionary',
    title: 'Lunch',
  });
  assert.equal(typeof e.id, 'number');
  assert.equal(e.amount, 12.5);
  assert.equal(e.type, 'expense');
  assert.equal(e.account, 'Revolut');
  assert.equal(e.category, 'Discretionary');
  assert.equal(e.title, 'Lunch');
  assert.equal(e.detail, null);
  assert.equal(e.is_recurring, false);
  assert.ok(e.created_at);

  const again = db.getEntry(e.id);
  assert.deepEqual(again, e);
});

test('income entry may omit the category', () => {
  const db = freshDb();
  const e = db.createEntry({ amount: 2000, type: 'income', date: '2026-09-01', account: 'Bank' });
  assert.equal(e.category, null);
  const e2 = db.createEntry({ amount: 50, type: 'income', date: '2026-09-01', account: 'Cash', category: 'Income' });
  assert.equal(e2.category, 'Income');
});

test('amounts are rounded to cents', () => {
  const db = freshDb();
  const e = db.createEntry({ amount: 10.005, type: 'expense', date: '2026-09-01', account: 'Cash', category: 'Savings' });
  assert.equal(e.amount, 10.01);
});

test('createEntry rejects bad input', () => {
  const db = freshDb();
  assert.throws(() => db.createEntry({ amount: -5, type: 'expense', date: '2026-09-01', account: 'Cash', category: 'Savings' }), /amount/);
  assert.throws(() => db.createEntry({ amount: 5, type: 'nope', date: '2026-09-01', account: 'Cash', category: 'Savings' }), /type/);
  assert.throws(() => db.createEntry({ amount: 5, type: 'expense', date: '2026-09-01', account: 'PayPal', category: 'Savings' }), /account/);
  assert.throws(() => db.createEntry({ amount: 5, type: 'expense', date: '2026/09/01', account: 'Cash', category: 'Savings' }), /date/);
  assert.throws(() => db.createEntry({ amount: 5, type: 'expense', date: '2026-09-01', account: 'Cash' }), /category/);
});

test('updateEntry changes only the given fields and re-validates', () => {
  const db = freshDb();
  const e = db.createEntry({ amount: 20, type: 'expense', date: '2026-09-01', account: 'Cash', category: 'Discretionary' });
  const u = db.updateEntry(e.id, { amount: 25.75, title: 'Groceries' });
  assert.equal(u.amount, 25.75);
  assert.equal(u.title, 'Groceries');
  assert.equal(u.account, 'Cash'); // untouched
  assert.equal(u.date, '2026-09-01'); // untouched

  assert.throws(() => db.updateEntry(e.id, { account: 'Nope' }), /account/);
  // switching to income clears the now-invalid expense category
  const toIncome = db.updateEntry(e.id, { type: 'income', category: null });
  assert.equal(toIncome.type, 'income');
  assert.equal(toIncome.category, null);
});

test('deleteEntry removes the row', () => {
  const db = freshDb();
  const e = db.createEntry({ amount: 5, type: 'expense', date: '2026-09-01', account: 'Cash', category: 'Savings' });
  assert.deepEqual(db.deleteEntry(e.id), { deleted: e.id });
  assert.throws(() => db.getEntry(e.id), /not found/);
  assert.throws(() => db.deleteEntry(e.id), /not found/);
});

test('listEntries filters by range, type, account, category', () => {
  const db = freshDb();
  db.createEntry({ amount: 100, type: 'income', date: '2026-08-15', account: 'Bank' });
  db.createEntry({ amount: 10, type: 'expense', date: '2026-09-01', account: 'Cash', category: 'Discretionary' });
  db.createEntry({ amount: 20, type: 'expense', date: '2026-09-02', account: 'Revolut', category: 'Savings' });
  db.createEntry({ amount: 30, type: 'expense', date: '2026-09-10', account: 'Cash', category: 'Discretionary' });

  assert.equal(db.listEntries({ from: '2026-09-01', to: '2026-09-05' }).length, 2);
  assert.equal(db.listEntries({ type: 'income' }).length, 1);
  assert.equal(db.listEntries({ account: 'Cash' }).length, 2);
  assert.equal(db.listEntries({ category: 'Discretionary' }).length, 2);
  // newest first
  const all = db.listEntries();
  assert.equal(all[0].date, '2026-09-10');
});

// ---------------------------------------------------------------- recurring

test('createRule also logs the first entry and sets the watermark', () => {
  const db = freshDb();
  const { rule, entry } = db.createRule({
    amount: 30,
    type: 'expense',
    account: 'Bank',
    category: 'Discretionary',
    title: 'Gym',
    interval: 'monthly',
    start_date: '2026-06-01',
  });
  assert.equal(rule.interval, 'monthly');
  assert.equal(rule.last_generated, '2026-06-01');
  assert.equal(entry.date, '2026-06-01');
  assert.equal(entry.is_recurring, true);
  assert.equal(entry.recurring_id, rule.id);
  assert.equal(db.listEntries({ recurringOnly: true }).length, 1);
});

test('dueOccurrences lists every missed period up to the reference date', () => {
  const db = freshDb();
  const { rule } = db.createRule({
    amount: 30, type: 'expense', account: 'Bank', category: 'Discretionary',
    title: 'Gym', interval: 'monthly', start_date: '2026-06-01',
  });
  const due = db.dueOccurrences('2026-09-01');
  assert.equal(due.length, 1);
  assert.equal(due[0].rule.id, rule.id);
  assert.deepEqual(due[0].occurrences.map((o) => o.date), ['2026-07-01', '2026-08-01', '2026-09-01']);
});

test('materialize creates only the chosen occurrences and advances the watermark past skipped ones', () => {
  const db = freshDb();
  const { rule } = db.createRule({
    amount: 30, type: 'expense', account: 'Bank', category: 'Discretionary',
    title: 'Gym', interval: 'monthly', start_date: '2026-06-01',
  });
  // choose Jul and Sep, deliberately skip Aug
  const res = db.materialize(
    [
      { rule_id: rule.id, date: '2026-07-01' },
      { rule_id: rule.id, date: '2026-09-01' },
    ],
    '2026-09-01'
  );
  assert.equal(res.created.length, 2);

  const gymEntries = db.listEntries({ recurringOnly: true }).map((e) => e.date).sort();
  assert.deepEqual(gymEntries, ['2026-06-01', '2026-07-01', '2026-09-01']);

  // watermark advanced to the latest offered date, so nothing is due again
  assert.equal(db.getRule(rule.id).last_generated, '2026-09-01');
  assert.equal(db.dueOccurrences('2026-09-01').length, 0);
});

test('inactive rule produces no due occurrences', () => {
  const db = freshDb();
  const { rule } = db.createRule({
    amount: 9.99, type: 'expense', account: 'Revolut', category: 'Discretionary',
    title: 'Music', interval: 'monthly', start_date: '2026-06-01',
  });
  db.updateRule(rule.id, { active: false });
  assert.equal(db.dueOccurrences('2026-12-01').length, 0);
  assert.equal(db.getRule(rule.id).next_due, null);
});

test('deleteRule keeps history but unlinks entries', () => {
  const db = freshDb();
  const { rule } = db.createRule({
    amount: 30, type: 'expense', account: 'Bank', category: 'Discretionary',
    title: 'Gym', interval: 'monthly', start_date: '2026-06-01',
  });
  db.deleteRule(rule.id);
  assert.throws(() => db.getRule(rule.id), /not found/);
  const rows = db.listEntries();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recurring_id, null);
});

test('monthly_equivalent normalises weekly and yearly costs', () => {
  const db = freshDb();
  const w = db.createRule({ amount: 12, type: 'expense', account: 'Cash', category: 'Discretionary', title: 'W', interval: 'weekly', start_date: '2026-01-01' });
  const y = db.createRule({ amount: 120, type: 'expense', account: 'Cash', category: 'Discretionary', title: 'Y', interval: 'yearly', start_date: '2026-01-01' });
  assert.equal(w.rule.monthly_equivalent, 52); // 12 * 52 / 12
  assert.equal(y.rule.monthly_equivalent, 10); // 120 / 12
});

// ---------------------------------------------------------------- dashboard

test('summary totals, category split, account split and previous-period comparison', () => {
  const db = freshDb();
  // reference "today" = Tue 2026-09-01. Week starts Mon 2026-08-31.
  // this week
  db.createEntry({ amount: 1000, type: 'income', date: '2026-08-31', account: 'Bank' });
  db.createEntry({ amount: 200, type: 'expense', date: '2026-08-31', account: 'Bank', category: 'Savings' });
  db.createEntry({ amount: 50, type: 'expense', date: '2026-09-01', account: 'Cash', category: 'Discretionary' });
  // previous week (same span: Mon 2026-08-24 .. Tue 2026-08-25)
  db.createEntry({ amount: 100, type: 'expense', date: '2026-08-24', account: 'Revolut', category: 'Discretionary' });
  // earlier in the month but before this week
  db.createEntry({ amount: 300, type: 'expense', date: '2026-08-10', account: 'Bank', category: 'Investments' });

  const s = db.summary('2026-09-01');

  // all-time
  assert.equal(s.all_time.income, 1000);
  assert.equal(s.all_time.expense, 650);
  assert.equal(s.all_time.net, 350);
  assert.equal(s.all_time.by_account.Bank, 1000 - 200 - 300);
  assert.equal(s.all_time.by_account.Cash, -50);
  assert.equal(s.all_time.by_account.Revolut, -100);

  // this week
  assert.equal(s.week.current.income, 1000);
  assert.equal(s.week.current.expense, 250);
  assert.equal(s.week.current.by_category.Savings, 200);
  assert.equal(s.week.current.by_category.Discretionary, 50);
  assert.equal(s.week.current.by_account.Bank, 800);
  assert.equal(s.week.current.by_account.Cash, -50);

  // previous week had 100 expense, 0 income
  assert.equal(s.week.previous.expense, 100);
  assert.equal(s.week.compare.expense.delta, 150);
  assert.equal(s.week.compare.expense.pct, 150);
  assert.equal(s.week.compare.income.previous, 0);
  assert.equal(s.week.compare.income.pct, null); // divide-by-zero guard

  // this month = Aug (offset 0 days -> 2026-08-01..2026-08-01 only? no: monthStart is 2026-09-01)
  // ref is 2026-09-01 so month = 2026-09-01..2026-09-01 -> only the 50 Discretionary
  assert.equal(s.month.current.expense, 50);
});

test('summary year window: Jan 1 -> ref vs the same span last year', () => {
  const db = freshDb();
  db.createEntry({ amount: 500, type: 'expense', date: '2026-03-15', account: 'Cash', category: 'Discretionary' });
  db.createEntry({ amount: 999, type: 'expense', date: '2026-11-01', account: 'Cash', category: 'Discretionary' }); // after ref
  db.createEntry({ amount: 200, type: 'expense', date: '2025-02-10', account: 'Cash', category: 'Discretionary' }); // prev year, in span
  db.createEntry({ amount: 77, type: 'expense', date: '2025-09-20', account: 'Cash', category: 'Discretionary' }); // prev year, after span

  const s = db.summary('2026-06-30');
  assert.equal(s.year.current.start, '2026-01-01');
  assert.equal(s.year.current.end, '2026-06-30');
  assert.equal(s.year.current.expense, 500);
  assert.equal(s.year.previous.start, '2025-01-01');
  assert.equal(s.year.previous.end, '2025-06-30');
  assert.equal(s.year.previous.expense, 200);
  assert.equal(s.year.compare.expense.delta, 300);
  assert.equal(s.year.compare.expense.pct, 150);
});

test('summary month window respects the day-of-month offset', () => {
  const db = freshDb();
  // ref 2026-09-15 -> month = 2026-09-01..2026-09-15, prev = 2026-08-01..2026-08-15
  db.createEntry({ amount: 10, type: 'expense', date: '2026-09-14', account: 'Cash', category: 'Discretionary' });
  db.createEntry({ amount: 99, type: 'expense', date: '2026-09-20', account: 'Cash', category: 'Discretionary' }); // after ref
  db.createEntry({ amount: 7, type: 'expense', date: '2026-08-10', account: 'Cash', category: 'Discretionary' });
  db.createEntry({ amount: 40, type: 'expense', date: '2026-08-25', account: 'Cash', category: 'Discretionary' }); // after prev window

  const s = db.summary('2026-09-15');
  assert.equal(s.month.current.expense, 10);
  assert.equal(s.month.previous.expense, 7);
});
