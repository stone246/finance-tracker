// dates.js — all date math. Dates are 'YYYY-MM-DD' strings in local time.
// Kept dependency-free and pure so it can be unit-tested on its own.

export function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function today() {
  return ymd(new Date());
}

export function isYmd(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parseYmd(s).getTime());
}

export function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

export function daysInMonth(year, monthIndex0) {
  return new Date(year, monthIndex0 + 1, 0).getDate();
}

// Add n calendar months, clamping the day to the end of the target month
// (Jan 31 + 1 month => Feb 28/29).
export function addMonths(s, n) {
  const d = parseYmd(s);
  const total = d.getMonth() + n;
  const y = d.getFullYear() + Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12;
  const day = Math.min(d.getDate(), daysInMonth(y, m));
  return ymd(new Date(y, m, day));
}

// Add n years, clamping Feb 29 -> Feb 28 on non-leap years.
export function addYears(s, n) {
  const d = parseYmd(s);
  const y = d.getFullYear() + n;
  const m = d.getMonth();
  const day = Math.min(d.getDate(), daysInMonth(y, m));
  return ymd(new Date(y, m, day));
}

export function startOfWeekMonday(s) {
  const d = parseYmd(s);
  const dow = (d.getDay() + 6) % 7; // Mon=0 .. Sun=6
  return addDays(s, -dow);
}

export function startOfMonth(s) {
  const d = parseYmd(s);
  return ymd(new Date(d.getFullYear(), d.getMonth(), 1));
}

export function startOfYear(s) {
  const d = parseYmd(s);
  return ymd(new Date(d.getFullYear(), 0, 1));
}

export function endOfMonth(s) {
  const d = parseYmd(s);
  return ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

export function diffDays(a, b) {
  return Math.round((parseYmd(b).getTime() - parseYmd(a).getTime()) / 86400000);
}

// The nth occurrence (n = 0, 1, 2, ...) of a recurring rule anchored at `anchor`.
export function nextOccurrence(anchor, interval, n) {
  if (interval === 'weekly') return addDays(anchor, 7 * n);
  if (interval === 'monthly') return addMonths(anchor, n);
  if (interval === 'yearly') return addYears(anchor, n);
  throw new Error('bad interval: ' + interval);
}

// Every occurrence date in (afterExclusive, throughInclusive], anchored at `anchor`.
// If afterExclusive is falsy, starts from `anchor` itself.
export function occurrencesBetween(anchor, interval, afterExclusive, throughInclusive) {
  const out = [];
  for (let n = 0; n < 100000; n++) {
    const occ = nextOccurrence(anchor, interval, n);
    if (occ > throughInclusive) break;
    if (occ >= anchor && (!afterExclusive || occ > afterExclusive)) out.push(occ);
  }
  return out;
}

// What one occurrence of a rule costs per month, for the "true monthly cost" total.
export function monthlyEquivalent(amount, interval) {
  if (interval === 'weekly') return (amount * 52) / 12;
  if (interval === 'monthly') return amount;
  if (interval === 'yearly') return amount / 12;
  return amount;
}
