// db.js — SQLite schema + all data-access functions.
// openDb(path) returns an object bundling the connection and every operation,
// so both server.js and the test suite use the exact same code paths.

import { DatabaseSync } from 'node:sqlite';
import {
  today,
  isYmd,
  addDays,
  addYears,
  startOfWeekMonday,
  startOfMonth,
  startOfYear,
  endOfMonth,
  diffDays,
  occurrencesBetween,
  monthlyEquivalent,
} from './dates.js';

export const ACCOUNTS = ['Cash', 'Revolut', 'Bank'];
export const EXPENSE_CATEGORIES = ['Savings', 'Investments', 'Discretionary'];
export const INTERVALS = ['weekly', 'monthly', 'yearly'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS recurring_rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  amount         REAL    NOT NULL CHECK (amount >= 0),
  type           TEXT    NOT NULL CHECK (type IN ('income','expense')),
  account        TEXT    NOT NULL CHECK (account IN ('Cash','Revolut','Bank')),
  category       TEXT,
  title          TEXT,
  detail         TEXT,
  interval       TEXT    NOT NULL CHECK (interval IN ('weekly','monthly','yearly')),
  start_date     TEXT    NOT NULL,
  last_generated TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  amount       REAL    NOT NULL CHECK (amount >= 0),
  type         TEXT    NOT NULL CHECK (type IN ('income','expense')),
  date         TEXT    NOT NULL,
  account      TEXT    NOT NULL CHECK (account IN ('Cash','Revolut','Bank')),
  category     TEXT    CHECK (category IN ('Savings','Investments','Discretionary','Income') OR category IS NULL),
  title        TEXT,
  detail       TEXT,
  is_recurring INTEGER NOT NULL DEFAULT 0,
  recurring_id INTEGER REFERENCES recurring_rules(id),
  created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
CREATE INDEX IF NOT EXISTS idx_entries_recurring ON entries(recurring_id);
`;

const eur = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const badRequest = (msg) => new HttpError(400, msg);
export const notFound = (msg) => new HttpError(404, msg);
export { HttpError };

// ---- validation -------------------------------------------------------------

function validateEntry(row) {
  if (!Number.isFinite(row.amount) || row.amount < 0) throw badRequest('amount must be a number >= 0');
  if (row.type !== 'income' && row.type !== 'expense') throw badRequest("type must be 'income' or 'expense'");
  if (!isYmd(row.date)) throw badRequest('date must be YYYY-MM-DD');
  if (!ACCOUNTS.includes(row.account)) throw badRequest('account must be one of ' + ACCOUNTS.join(', '));
  if (row.type === 'expense') {
    if (!EXPENSE_CATEGORIES.includes(row.category)) {
      throw badRequest('expense category must be one of ' + EXPENSE_CATEGORIES.join(', '));
    }
  } else if (row.category != null && row.category !== 'Income') {
    throw badRequest("income category must be blank or 'Income'");
  }
}

function validateRuleInput(r) {
  if (!Number.isFinite(eur(r.amount)) || eur(r.amount) < 0) throw badRequest('amount must be a number >= 0');
  if (r.type !== 'income' && r.type !== 'expense') throw badRequest("type must be 'income' or 'expense'");
  if (!ACCOUNTS.includes(r.account)) throw badRequest('account must be one of ' + ACCOUNTS.join(', '));
  if (!INTERVALS.includes(r.interval)) throw badRequest('interval must be one of ' + INTERVALS.join(', '));
  if (!isYmd(r.start_date)) throw badRequest('start_date must be YYYY-MM-DD');
  if (r.type === 'expense' && !EXPENSE_CATEGORIES.includes(r.category)) {
    throw badRequest('expense category must be one of ' + EXPENSE_CATEGORIES.join(', '));
  }
}

// ---- main -----------------------------------------------------------------

export function openDb(path = 'finance.db') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  // ---- entries ----

  function getEntry(id) {
    const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
    if (!row) throw notFound('entry ' + id + ' not found');
    return normEntry(row);
  }

  function normEntry(row) {
    return { ...row, amount: eur(row.amount), is_recurring: !!row.is_recurring };
  }

  function createEntry(input) {
    const row = {
      amount: eur(input.amount),
      type: input.type,
      date: input.date || today(),
      account: input.account,
      category:
        input.type === 'income'
          ? input.category || null
          : input.category ?? null,
      title: emptyToNull(input.title),
      detail: emptyToNull(input.detail),
      is_recurring: input.is_recurring ? 1 : 0,
      recurring_id: input.recurring_id ?? null,
      created_at: new Date().toISOString(),
    };
    validateEntry(row);
    const info = db
      .prepare(
        `INSERT INTO entries
           (amount,type,date,account,category,title,detail,is_recurring,recurring_id,created_at)
         VALUES
           (:amount,:type,:date,:account,:category,:title,:detail,:is_recurring,:recurring_id,:created_at)`
      )
      .run(row);
    return getEntry(info.lastInsertRowid);
  }

  const ENTRY_FIELDS = ['amount', 'type', 'date', 'account', 'category', 'title', 'detail', 'is_recurring'];

  function updateEntry(id, patch) {
    const current = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
    if (!current) throw notFound('entry ' + id + ' not found');

    const merged = { ...current };
    for (const key of ENTRY_FIELDS) {
      if (key in patch) merged[key] = patch[key];
    }
    merged.amount = eur(merged.amount);
    if (merged.type === 'income' && merged.category !== 'Income') merged.category = merged.category || null;
    merged.title = emptyToNull(merged.title);
    merged.detail = emptyToNull(merged.detail);
    validateEntry(merged);

    db.prepare(
      `UPDATE entries SET
         amount=:amount, type=:type, date=:date, account=:account, category=:category,
         title=:title, detail=:detail, is_recurring=:is_recurring
       WHERE id=:id`
    ).run({
      id,
      amount: merged.amount,
      type: merged.type,
      date: merged.date,
      account: merged.account,
      category: merged.category ?? null,
      title: merged.title,
      detail: merged.detail,
      is_recurring: merged.is_recurring ? 1 : 0,
    });
    return getEntry(id);
  }

  function deleteEntry(id) {
    const info = db.prepare('DELETE FROM entries WHERE id = ?').run(id);
    if (info.changes === 0) throw notFound('entry ' + id + ' not found');
    return { deleted: id };
  }

  function listEntries(filter = {}) {
    const where = [];
    const params = {};
    if (filter.from) {
      where.push('date >= :from');
      params.from = filter.from;
    }
    if (filter.to) {
      where.push('date <= :to');
      params.to = filter.to;
    }
    if (filter.type) {
      where.push('type = :type');
      params.type = filter.type;
    }
    if (filter.account) {
      where.push('account = :account');
      params.account = filter.account;
    }
    if (filter.category) {
      where.push('category = :category');
      params.category = filter.category;
    }
    if (filter.recurringOnly) where.push('is_recurring = 1');
    const sql =
      'SELECT * FROM entries' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY date DESC, id DESC' +
      (filter.limit ? ' LIMIT ' + Number(filter.limit) : '');
    return db.prepare(sql).all(params).map(normEntry);
  }

  // ---- recurring rules ----

  function normRule(row) {
    return {
      ...row,
      amount: eur(row.amount),
      active: !!row.active,
      next_due: nextDueFor(row),
      monthly_equivalent: eur(monthlyEquivalent(row.amount, row.interval)),
    };
  }

  function nextDueFor(row) {
    if (!row.active) return null;
    const after = row.last_generated || null;
    const horizon = addDays(today(), 366 * 5);
    const upcoming = occurrencesBetween(row.start_date, row.interval, after, horizon);
    return upcoming.length ? upcoming[0] : null;
  }

  function getRule(id) {
    const row = db.prepare('SELECT * FROM recurring_rules WHERE id = ?').get(id);
    if (!row) throw notFound('recurring rule ' + id + ' not found');
    return normRule(row);
  }

  function listRules(filter = {}) {
    const sql =
      'SELECT * FROM recurring_rules' +
      (filter.activeOnly ? ' WHERE active = 1' : '') +
      ' ORDER BY active DESC, type, title, id';
    return db.prepare(sql).all().map(normRule);
  }

  // Creating a rule also logs its first entry (on start_date) in one transaction.
  function createRule(input) {
    const rule = {
      amount: eur(input.amount),
      type: input.type,
      account: input.account,
      category:
        input.type === 'income' ? input.category || null : input.category ?? null,
      title: emptyToNull(input.title),
      detail: emptyToNull(input.detail),
      interval: input.interval,
      start_date: input.start_date || today(),
      created_at: new Date().toISOString(),
    };
    validateRuleInput(rule);

    return tx(() => {
      const info = db
        .prepare(
          `INSERT INTO recurring_rules
             (amount,type,account,category,title,detail,interval,start_date,last_generated,active,created_at)
           VALUES
             (:amount,:type,:account,:category,:title,:detail,:interval,:start_date,:start_date,1,:created_at)`
        )
        .run(rule);
      const ruleId = info.lastInsertRowid;
      const firstEntry = createEntry({
        amount: rule.amount,
        type: rule.type,
        date: rule.start_date,
        account: rule.account,
        category: rule.category,
        title: rule.title,
        detail: rule.detail,
        is_recurring: 1,
        recurring_id: ruleId,
      });
      return { rule: getRule(ruleId), entry: firstEntry };
    });
  }

  const RULE_FIELDS = ['amount', 'type', 'account', 'category', 'title', 'detail', 'interval', 'active'];

  function updateRule(id, patch) {
    const current = db.prepare('SELECT * FROM recurring_rules WHERE id = ?').get(id);
    if (!current) throw notFound('recurring rule ' + id + ' not found');
    const merged = { ...current };
    for (const key of RULE_FIELDS) if (key in patch) merged[key] = patch[key];
    merged.amount = eur(merged.amount);
    merged.title = emptyToNull(merged.title);
    merged.detail = emptyToNull(merged.detail);
    if (merged.type === 'income' && merged.category !== 'Income') merged.category = merged.category || null;
    validateRuleInput(merged);

    db.prepare(
      `UPDATE recurring_rules SET
         amount=:amount, type=:type, account=:account, category=:category,
         title=:title, detail=:detail, interval=:interval, active=:active
       WHERE id=:id`
    ).run({
      id,
      amount: merged.amount,
      type: merged.type,
      account: merged.account,
      category: merged.category ?? null,
      title: merged.title,
      detail: merged.detail,
      interval: merged.interval,
      active: merged.active ? 1 : 0,
    });
    return getRule(id);
  }

  // Delete the rule only. Entries it already generated stay as history,
  // but lose their link so nothing dangles.
  function deleteRule(id) {
    return tx(() => {
      db.prepare('UPDATE entries SET recurring_id = NULL WHERE recurring_id = ?').run(id);
      const info = db.prepare('DELETE FROM recurring_rules WHERE id = ?').run(id);
      if (info.changes === 0) throw notFound('recurring rule ' + id + ' not found');
      return { deleted: id };
    });
  }

  // ---- recurring catch-up ("ask me to confirm") ----

  // Every occurrence that has come due since each active rule's watermark.
  function dueOccurrences(ref = today()) {
    const rules = db.prepare('SELECT * FROM recurring_rules WHERE active = 1').all();
    const out = [];
    for (const rule of rules) {
      const dates = occurrencesBetween(
        rule.start_date,
        rule.interval,
        rule.last_generated || null,
        ref
      );
      if (dates.length) {
        out.push({
          rule: normRule(rule),
          occurrences: dates.map((date) => ({
            rule_id: rule.id,
            date,
            amount: eur(rule.amount),
            type: rule.type,
            account: rule.account,
            category: rule.category,
            title: rule.title,
          })),
        });
      }
    }
    return out;
  }

  // Create entries for the chosen {rule_id, date} pairs. Any due date that was
  // offered but not chosen is treated as a conscious skip: the watermark still
  // advances past it so it does not nag again.
  function materialize(selections = [], ref = today()) {
    const chosen = new Set(selections.map((s) => `${s.rule_id}|${s.date}`));
    return tx(() => {
      const due = dueOccurrences(ref);
      const created = [];
      for (const { rule, occurrences } of due) {
        for (const occ of occurrences) {
          if (chosen.has(`${rule.id}|${occ.date}`)) {
            created.push(
              createEntry({
                amount: rule.amount,
                type: rule.type,
                date: occ.date,
                account: rule.account,
                category: rule.category,
                title: rule.title,
                detail: rule.detail,
                is_recurring: 1,
                recurring_id: rule.id,
              })
            );
          }
        }
        const latestOffered = occurrences[occurrences.length - 1].date;
        db.prepare(
          `UPDATE recurring_rules SET last_generated = ?
             WHERE id = ? AND (last_generated IS NULL OR last_generated < ?)`
        ).run(latestOffered, rule.id, latestOffered);
      }
      return { created };
    });
  }

  // ---- dashboard summary ----

  function periodAgg(start, end) {
    const rows = db
      .prepare(
        `SELECT type, account, category, SUM(amount) AS amt, COUNT(*) AS n
           FROM entries WHERE date >= ? AND date <= ?
          GROUP BY type, account, category`
      )
      .all(start, end);

    const agg = {
      start,
      end,
      income: 0,
      expense: 0,
      net: 0,
      count: 0,
      by_category: { Savings: 0, Investments: 0, Discretionary: 0 },
      by_account: { Cash: 0, Revolut: 0, Bank: 0 },
    };
    for (const r of rows) {
      agg.count += r.n;
      if (r.type === 'income') {
        agg.income += r.amt;
        agg.by_account[r.account] += r.amt;
      } else {
        agg.expense += r.amt;
        agg.by_account[r.account] -= r.amt;
        if (r.category in agg.by_category) agg.by_category[r.category] += r.amt;
      }
    }
    agg.income = eur(agg.income);
    agg.expense = eur(agg.expense);
    agg.net = eur(agg.income - agg.expense);
    for (const k in agg.by_category) agg.by_category[k] = eur(agg.by_category[k]);
    for (const k in agg.by_account) agg.by_account[k] = eur(agg.by_account[k]);
    return agg;
  }

  function compare(current, previous) {
    const mk = (c, p) => {
      const delta = eur(c - p);
      const pct = p === 0 ? null : Math.round((delta / Math.abs(p)) * 1000) / 10;
      return { current: eur(c), previous: eur(p), delta, pct };
    };
    return {
      income: mk(current.income, previous.income),
      expense: mk(current.expense, previous.expense),
      net: mk(current.net, previous.net),
    };
  }

  function summary(ref = today()) {
    // week: Monday -> ref, vs the same span one week earlier
    const weekStart = startOfWeekMonday(ref);
    const weekPrevStart = addDays(weekStart, -7);
    const weekPrevEnd = addDays(ref, -7);

    // month: 1st -> ref, vs the same number of days into the previous month
    const monthStart = startOfMonth(ref);
    const offset = diffDays(monthStart, ref);
    const prevMonthStart = startOfMonth(addDays(monthStart, -1));
    const prevMonthEndCap = endOfMonth(prevMonthStart);
    let prevMonthEnd = addDays(prevMonthStart, offset);
    if (prevMonthEnd > prevMonthEndCap) prevMonthEnd = prevMonthEndCap;

    // year: Jan 1 -> ref, vs the same calendar span of the previous year
    const yearStart = startOfYear(ref);
    const yearPrevStart = addYears(yearStart, -1);
    const yearPrevEnd = addYears(ref, -1);

    const week = periodAgg(weekStart, ref);
    const weekPrev = periodAgg(weekPrevStart, weekPrevEnd);
    const month = periodAgg(monthStart, ref);
    const monthPrev = periodAgg(prevMonthStart, prevMonthEnd);
    const year = periodAgg(yearStart, ref);
    const yearPrev = periodAgg(yearPrevStart, yearPrevEnd);

    const allTime = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN type='income'  THEN amount END),0) AS income,
           COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense
         FROM entries`
      )
      .get();

    const acctRows = db
      .prepare(
        `SELECT account,
           COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END),0) AS bal
         FROM entries GROUP BY account`
      )
      .all();
    const accountBalances = { Cash: 0, Revolut: 0, Bank: 0 };
    for (const r of acctRows) accountBalances[r.account] = eur(r.bal);

    return {
      ref,
      all_time: {
        income: eur(allTime.income),
        expense: eur(allTime.expense),
        net: eur(allTime.income - allTime.expense),
        by_account: accountBalances,
      },
      week: { current: week, previous: weekPrev, compare: compare(week, weekPrev) },
      month: { current: month, previous: monthPrev, compare: compare(month, monthPrev) },
      year: { current: year, previous: yearPrev, compare: compare(year, yearPrev) },
    };
  }

  return {
    raw: db,
    close: () => db.close(),
    ACCOUNTS,
    EXPENSE_CATEGORIES,
    INTERVALS,
    getEntry,
    createEntry,
    updateEntry,
    deleteEntry,
    listEntries,
    getRule,
    listRules,
    createRule,
    updateRule,
    deleteRule,
    dueOccurrences,
    materialize,
    summary,
  };
}

function emptyToNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
