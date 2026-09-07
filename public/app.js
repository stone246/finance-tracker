// app.js — finance tracker front-end (vanilla ES modules).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const byId = (id) => document.getElementById(id);

const eur = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' });
const money = (n) => eur.format(Number(n) || 0);
const todayStr = () => new Date().toLocaleDateString('en-CA');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let lastSummary = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(text) {
  const t = byId('toast');
  t.textContent = text;
  t.hidden = false;
  t.style.animation = 'none';
  void t.offsetWidth;
  t.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ---- animated counters ------------------------------------------------

function animateCount(el, to) {
  const from = el._shown ?? (parseFloat(el.dataset.value) || 0);
  el.dataset.value = String(to);
  if (el._raf) cancelAnimationFrame(el._raf);
  if (reduceMotion || Math.abs(to - from) < 0.005) {
    el._shown = to;
    el.textContent = money(to);
    return;
  }
  const dur = 750;
  const t0 = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    el._shown = from + (to - from) * ease(p);
    el.textContent = money(el._shown);
    if (p < 1) el._raf = requestAnimationFrame(tick);
    else {
      el._shown = to;
      el.textContent = money(to);
      el._raf = null;
    }
  };
  el._raf = requestAnimationFrame(tick);
}

// ---- segmented controls --------------------------------------------

function positionThumb(wrap) {
  const thumb = wrap.querySelector('.seg-thumb');
  if (!thumb) return;
  const active = wrap.querySelector('button.active');
  if (!active || !active.offsetWidth) return;
  thumb.style.width = active.offsetWidth + 'px';
  thumb.style.transform = `translateX(${active.offsetLeft - 4}px)`;
}

function initSegmented(id, onChange) {
  const wrap = byId(id);
  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-val]');
    if (!btn) return;
    $$('button', wrap).forEach((b) => b.classList.toggle('active', b === btn));
    wrap.dataset.value = btn.dataset.val;
    positionThumb(wrap);
    onChange && onChange(btn.dataset.val);
  });
  positionThumb(wrap);
}
const segValue = (id) => byId(id).dataset.value;
function setSeg(id, val) {
  const wrap = byId(id);
  wrap.dataset.value = val || '';
  $$('button', wrap).forEach((b) => b.classList.toggle('active', b.dataset.val === val));
  positionThumb(wrap);
}

// ---- view routing ------------------------------------------------

const VIEWS = ['dashboard', 'entries', 'recurring'];

function showView(name) {
  VIEWS.forEach((v) => {
    const el = byId('view-' + v);
    if (v === name) {
      el.hidden = false;
      void el.offsetWidth;
      el.classList.add('is-active');
    } else {
      el.classList.remove('is-active');
      el.hidden = true;
    }
  });
  byId('nav-entries').classList.toggle('is-active', name === 'entries');
  byId('nav-recurring').classList.toggle('is-active', name === 'recurring');

  if (name === 'dashboard') {
    const dv = byId('view-dashboard');
    dv.classList.remove('play');
    void dv.offsetWidth;
    dv.classList.add('play');
    positionThumb(byId('dash-period'));
    loadDashboard();
  }
  if (name === 'entries') loadEntries();
  if (name === 'recurring') loadRecurring();
}

function refreshAll() {
  loadDashboard();
  const active = VIEWS.find((v) => !byId('view-' + v).hidden);
  if (active === 'entries') loadEntries();
  if (active === 'recurring') loadRecurring();
}

// ---- dashboard --------------------------------------------------

async function loadDashboard() {
  const s = await api('/api/summary');
  lastSummary = s;
  renderHeader(s);
  renderDashboard(s);
}

function renderHeader(s) {
  const bal = byId('balance-total');
  animateCount(bal, s.all_time.net);
  bal.style.color = s.all_time.net < 0 ? 'var(--neg)' : '';
  byId('balance-sub').textContent =
    `Income ${money(s.all_time.income)} · Expenses ${money(s.all_time.expense)} all-time`;
  ['Cash', 'Revolut', 'Bank'].forEach((a) => animateCount(byId('acct-' + a), s.all_time.by_account[a]));
}

function cmpHtml(c, kind, prevWord) {
  const { delta, pct, previous } = c;
  if (Math.abs(delta) < 0.005) return `<span>no change vs ${prevWord} (${money(previous)})</span>`;
  const up = delta > 0;
  const arrow = up ? '▲' : '▼';
  const good = kind === 'expense' ? !up : up;
  let pctText = '';
  if (pct === null) pctText = previous === 0 ? ' · new' : '';
  else if (Math.abs(pct) > 1000) pctText = pct > 0 ? ' (>+999%)' : ' (<−999%)';
  else {
    const shown = Math.abs(pct) >= 100 ? Math.round(pct) : pct;
    pctText = ` (${pct > 0 ? '+' : ''}${shown}%)`;
  }
  return `<span class="delta ${good ? 'good' : 'bad'}">${arrow} ${money(Math.abs(delta))}${pctText}</span> vs ${prevWord} (${money(previous)})`;
}

function barRow(label, value, max) {
  let w = max > 0 ? Math.round((Math.abs(value) / max) * 100) : 0;
  if (w === 0 && Math.abs(value) >= 0.005) w = 1; // keep a visible nub for small non-zero values
  return `<div class="bar-row">
    <span class="bar-label">${label}</span>
    <span class="bar-track"><span class="bar-fill ${value < 0 ? 'neg' : ''}" data-w="${w}"></span></span>
    <span class="bar-val">${money(value)}</span>
  </div>`;
}

function animateBars() {
  const fills = $$('#dash-body .bar-fill');
  if (reduceMotion) {
    fills.forEach((f) => (f.style.width = f.dataset.w + '%'));
    return;
  }
  fills.forEach((f) => (f.style.width = '0%'));
  requestAnimationFrame(() =>
    requestAnimationFrame(() => fills.forEach((f) => (f.style.width = f.dataset.w + '%')))
  );
}

function renderDashboard(s) {
  const which = segValue('dash-period');
  const block = s[which];
  const cur = block.current;
  const prevWord = which === 'week' ? 'last week' : which === 'month' ? 'last month' : 'last year';

  byId('dash-range').textContent =
    `${cur.start} → ${cur.end}   ·   vs   ${block.previous.start} → ${block.previous.end}`;

  animateCount(byId('stat-income'), cur.income);
  animateCount(byId('stat-expense'), cur.expense);
  const net = byId('stat-net');
  animateCount(net, cur.net);
  net.style.color = cur.net < 0 ? 'var(--neg)' : 'var(--pos)';

  byId('cmp-income').innerHTML = cmpHtml(block.compare.income, 'income', prevWord);
  byId('cmp-expense').innerHTML = cmpHtml(block.compare.expense, 'expense', prevWord);
  byId('cmp-net').innerHTML = cmpHtml(block.compare.net, 'net', prevWord);

  const cats = ['Savings', 'Investments', 'Discretionary'];
  const catMax = Math.max(1, ...cats.map((c) => cur.by_category[c]));
  byId('chart-category').innerHTML =
    cats.map((c) => barRow(c, cur.by_category[c], catMax)).join('') +
    `<p class="chart-foot">Total ${money(cur.expense)} · ${cmpHtml(block.compare.expense, 'expense', prevWord)}</p>`;

  const accts = ['Cash', 'Revolut', 'Bank'];
  const accMax = Math.max(1, ...accts.map((a) => Math.abs(cur.by_account[a])));
  byId('chart-account').innerHTML = accts.map((a) => barRow(a, cur.by_account[a], accMax)).join('');

  animateBars();
}

function onPeriodChange() {
  positionThumb(byId('dash-period'));
  if (!lastSummary) return;
  const body = byId('dash-body');
  if (reduceMotion) {
    renderDashboard(lastSummary);
    return;
  }
  body.classList.add('swapping');
  setTimeout(() => {
    renderDashboard(lastSummary);
    body.classList.remove('swapping');
  }, 180);
}

// ---- add entry modal --------------------------------------------

function openAddModal() {
  const f = byId('log-form');
  f.reset();
  byId('log-date').value = todayStr();
  setSeg('log-type', 'expense');
  setSeg('log-account', '');
  setSeg('log-category', '');
  byId('log-category-field').hidden = false;
  byId('log-interval').disabled = true;
  byId('log-msg').hidden = true;
  byId('add-modal').showModal();
  setTimeout(() => byId('log-amount').focus(), 60);
}

function initLogForm() {
  byId('log-cancel').addEventListener('click', () => byId('add-modal').close());

  initSegmented('log-type', (val) => {
    byId('log-category-field').hidden = val === 'income';
    if (val === 'income') setSeg('log-category', '');
  });
  initSegmented('log-account');
  initSegmented('log-category');

  const recur = byId('log-recurring');
  recur.addEventListener('change', () => (byId('log-interval').disabled = !recur.checked));

  byId('log-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = byId('log-msg');
    const type = segValue('log-type');
    const account = segValue('log-account');
    const category = segValue('log-category');
    const amount = parseFloat(byId('log-amount').value);

    const missing = [];
    if (!(amount >= 0)) missing.push('amount');
    if (!account) missing.push('account');
    if (type === 'expense' && !category) missing.push('category');
    if (missing.length) {
      msg.hidden = false;
      msg.className = 'msg err';
      msg.textContent = 'Missing: ' + missing.join(', ');
      return;
    }

    const payload = {
      amount,
      type,
      date: byId('log-date').value || todayStr(),
      account,
      category: type === 'expense' ? category : null,
      title: byId('log-title').value,
      detail: byId('log-detail').value,
    };

    try {
      if (recur.checked) {
        payload.interval = byId('log-interval').value;
        payload.start_date = payload.date;
        delete payload.date;
        await api('/api/recurring', { method: 'POST', body: payload });
        toast('Recurring entry saved + first one logged');
      } else {
        await api('/api/entries', { method: 'POST', body: payload });
        toast('Logged ' + money(amount));
      }
      byId('add-modal').close();
      refreshAll();
    } catch (err) {
      msg.hidden = false;
      msg.className = 'msg err';
      msg.textContent = err.message;
    }
  });
}

// ---- nav -------------------------------------------------------

function initNav() {
  byId('home-link').addEventListener('click', () => showView('dashboard'));
  byId('nav-add').addEventListener('click', openAddModal);
  byId('nav-entries').addEventListener('click', () =>
    showView(byId('nav-entries').classList.contains('is-active') ? 'dashboard' : 'entries')
  );
  byId('nav-recurring').addEventListener('click', () =>
    showView(byId('nav-recurring').classList.contains('is-active') ? 'dashboard' : 'recurring')
  );
}

// ---- entries -------------------------------------------------

function filterQuery() {
  const p = new URLSearchParams();
  const map = { from: 'f-from', to: 'f-to', type: 'f-type', account: 'f-account', category: 'f-category' };
  for (const [k, id] of Object.entries(map)) {
    const v = byId(id).value;
    if (v) p.set(k, v);
  }
  return p.toString();
}

async function loadEntries() {
  const rows = await api('/api/entries?' + filterQuery());
  const tb = $('#entries-table tbody');
  byId('entries-empty').hidden = rows.length > 0;
  tb.innerHTML = rows
    .map(
      (e) => `<tr data-id="${e.id}">
      <td>${e.date}</td>
      <td><span class="tag ${e.type}">${e.type}</span>${e.is_recurring ? ' <span class="recur-dot" title="recurring">↻</span>' : ''}</td>
      <td class="num">${money(e.amount)}</td>
      <td>${e.account}</td>
      <td>${e.category || ''}</td>
      <td>${escapeHtml(e.title || '')}${e.detail ? ` <span class="hint">${escapeHtml(e.detail)}</span>` : ''}</td>
      <td class="row-actions"><button class="link" data-act="edit">Edit</button></td>
      <td class="row-actions"><button class="link" data-act="del">Delete</button></td>
    </tr>`
    )
    .join('');
}

function initEntries() {
  ['f-from', 'f-to', 'f-type', 'f-account', 'f-category'].forEach((id) =>
    byId(id).addEventListener('change', loadEntries)
  );
  byId('f-clear').addEventListener('click', () => {
    ['f-from', 'f-to', 'f-type', 'f-account', 'f-category'].forEach((id) => (byId(id).value = ''));
    loadEntries();
  });

  $('#entries-table tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    if (btn.dataset.act === 'del') {
      if (!confirm('Delete this entry?')) return;
      await api('/api/entries/' + id, { method: 'DELETE' });
      toast('Entry deleted');
      refreshAll();
    } else {
      openEntryEditor(await api('/api/entries/' + id));
    }
  });
}

function openEntryEditor(entry) {
  openEditor('Edit entry', [
    { name: 'amount', label: 'Amount (€)', type: 'number', step: '0.01', value: entry.amount },
    { name: 'type', label: 'Type', type: 'select', options: ['income', 'expense'], value: entry.type },
    { name: 'date', label: 'Date', type: 'date', value: entry.date },
    { name: 'account', label: 'Account', type: 'select', options: ['Cash', 'Revolut', 'Bank'], value: entry.account },
    { name: 'category', label: 'Category', type: 'select', options: ['', 'Savings', 'Investments', 'Discretionary', 'Income'], value: entry.category || '' },
    { name: 'title', label: 'Title', type: 'text', value: entry.title || '' },
    { name: 'detail', label: 'Detail', type: 'text', value: entry.detail || '' },
    { name: 'is_recurring', label: 'Marked recurring', type: 'checkbox', value: entry.is_recurring },
  ], async (vals) => {
    vals.amount = parseFloat(vals.amount);
    vals.category = vals.category || null;
    await api('/api/entries/' + entry.id, { method: 'PATCH', body: vals });
    toast('Entry updated');
    refreshAll();
  });
}

// ---- recurring / monthly expenditures ----------------------

async function loadRecurring() {
  const rules = await api('/api/recurring');
  const tb = $('#recurring-table tbody');
  byId('recurring-empty').hidden = rules.length > 0;

  const monthlyCost = rules
    .filter((r) => r.type === 'expense' && r.active)
    .reduce((sum, r) => sum + r.monthly_equivalent, 0);
  animateCount(byId('recurring-monthly'), monthlyCost);

  tb.innerHTML = rules
    .map(
      (r) => `<tr data-id="${r.id}">
      <td>${escapeHtml(r.title || '(untitled)')} <span class="tag ${r.type}">${r.type}</span></td>
      <td class="num">${money(r.amount)}</td>
      <td>${r.interval}</td>
      <td class="num">${r.type === 'expense' ? money(r.monthly_equivalent) : ''}</td>
      <td>${r.account}</td>
      <td>${r.category || ''}</td>
      <td>${r.next_due || '—'}</td>
      <td><input type="checkbox" data-act="toggle" ${r.active ? 'checked' : ''}></td>
      <td class="row-actions"><button class="link" data-act="edit">Edit</button></td>
      <td class="row-actions"><button class="link" data-act="del">Delete</button></td>
    </tr>`
    )
    .join('');
}

function initRecurring() {
  $('#recurring-table tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    const toggle = e.target.closest('input[data-act="toggle"]');
    const tr = e.target.closest('tr');
    if (!tr) return;
    const id = tr.dataset.id;

    if (toggle) {
      await api('/api/recurring/' + id, { method: 'PATCH', body: { active: toggle.checked } });
      toast(toggle.checked ? 'Recurring resumed' : 'Recurring paused');
      loadRecurring();
      loadDashboard();
      return;
    }
    if (!btn) return;
    if (btn.dataset.act === 'del') {
      if (!confirm('Delete this recurring rule? Entries already logged stay.')) return;
      await api('/api/recurring/' + id, { method: 'DELETE' });
      toast('Recurring rule deleted');
      refreshAll();
    } else {
      const rules = await api('/api/recurring');
      openRuleEditor(rules.find((r) => String(r.id) === id));
    }
  });
}

function openRuleEditor(rule) {
  openEditor('Edit recurring entry', [
    { name: 'amount', label: 'Amount (€)', type: 'number', step: '0.01', value: rule.amount },
    { name: 'type', label: 'Type', type: 'select', options: ['income', 'expense'], value: rule.type },
    { name: 'interval', label: 'Repeats', type: 'select', options: ['weekly', 'monthly', 'yearly'], value: rule.interval },
    { name: 'account', label: 'Account', type: 'select', options: ['Cash', 'Revolut', 'Bank'], value: rule.account },
    { name: 'category', label: 'Category', type: 'select', options: ['', 'Savings', 'Investments', 'Discretionary', 'Income'], value: rule.category || '' },
    { name: 'title', label: 'Title', type: 'text', value: rule.title || '' },
    { name: 'detail', label: 'Detail', type: 'text', value: rule.detail || '' },
    { name: 'active', label: 'Active', type: 'checkbox', value: rule.active },
  ], async (vals) => {
    vals.amount = parseFloat(vals.amount);
    vals.category = vals.category || null;
    await api('/api/recurring/' + rule.id, { method: 'PATCH', body: vals });
    toast('Recurring entry updated');
    refreshAll();
  });
}

// ---- generic editor modal --------------------------------

function openEditor(title, fields, onSave) {
  const modal = byId('edit-modal');
  byId('edit-title').textContent = title;
  byId('edit-fields').innerHTML = fields
    .map((f) => {
      if (f.type === 'select') {
        return `<label class="field"><span>${f.label}</span>
          <select name="${f.name}">${f.options
            .map((o) => `<option value="${o}" ${o === f.value ? 'selected' : ''}>${o || '—'}</option>`)
            .join('')}</select></label>`;
      }
      if (f.type === 'checkbox') {
        return `<label class="checkbox"><input type="checkbox" name="${f.name}" ${f.value ? 'checked' : ''}> ${f.label}</label>`;
      }
      return `<label class="field"><span>${f.label}</span>
        <input type="${f.type}" name="${f.name}" ${f.step ? `step="${f.step}"` : ''} value="${escapeAttr(String(f.value ?? ''))}"></label>`;
    })
    .join('');

  const form = byId('edit-form');
  const onSubmit = async (e) => {
    e.preventDefault();
    const vals = {};
    fields.forEach((f) => {
      const node = form.elements[f.name];
      vals[f.name] = f.type === 'checkbox' ? node.checked : node.value;
    });
    try {
      await onSave(vals);
      close();
    } catch (err) {
      alert(err.message);
    }
  };
  function close() {
    form.removeEventListener('submit', onSubmit);
    modal.close();
  }
  byId('edit-cancel').onclick = close;
  form.addEventListener('submit', onSubmit);
  modal.showModal();
}

// ---- recurring due prompt (on load) ---------------------

async function checkDue() {
  const due = await api('/api/recurring/due');
  if (!due.length) return;
  byId('due-list').innerHTML = due
    .map(
      (d) =>
        `<div class="due-group-label">${escapeHtml(d.rule.title || '(untitled)')} · ${money(d.rule.amount)} · ${d.rule.interval}</div>` +
        d.occurrences
          .map(
            (o) => `<label class="due-item">
              <input type="checkbox" checked data-rule="${o.rule_id}" data-date="${o.date}">
              <span>${o.date} — ${money(o.amount)} ${o.type} · ${o.account}${o.category ? ' · ' + o.category : ''}</span>
            </label>`
          )
          .join('')
    )
    .join('');

  const modal = byId('due-modal');
  modal.returnValue = '';
  modal.showModal();
  modal.addEventListener(
    'close',
    async () => {
      if (modal.returnValue !== 'confirm') return;
      const selections = $$('#due-list input:checked').map((c) => ({
        rule_id: Number(c.dataset.rule),
        date: c.dataset.date,
      }));
      const res = await api('/api/recurring/materialize', { method: 'POST', body: { selections } });
      toast(`${res.created.length} recurring ${res.created.length === 1 ? 'entry' : 'entries'} added`);
      refreshAll();
    },
    { once: true }
  );
}

// ---- misc ----------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeAttr = escapeHtml;

// ---- boot --------------------------------------------

function boot() {
  initLogForm();
  initSegmented('dash-period', onPeriodChange);
  initNav();
  initEntries();
  initRecurring();
  showView('dashboard');
  checkDue();

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => positionThumb(byId('dash-period')));
  }
  window.addEventListener('resize', () => positionThumb(byId('dash-period')));
}

try {
  boot();
} catch (err) {
  console.error(err);
  $$('.reveal').forEach((el) => (el.style.opacity = 1));
  $$('.view').forEach((el) => el.classList.add('is-active'));
}
