// eb/routes.js — HTTP surface for the Enable Banking integration.
//
//   GET  /eb                 status page + "Connect" button
//   GET  /eb/connect         start consent -> 302 to the bank
//   GET  /callback           bank returns here (?code=&state=) -> sync -> 302 /eb
//   GET  /eb/callback        same handler (alias)
//   GET  /eb/status          JSON: accounts, latest balances, sync log
//   GET  /eb/aspsps          JSON: ASPSP list (?country=&q=)
//   GET  /eb/application     JSON: application metadata (registered redirects)
//   GET  /eb/refresh         re-pull balances + transactions for last session
//
// No payment routes exist. This module is Account Information only.

import { EB } from './config.js';
import { listAspsps, getApplication } from './client.js';
import { beginAuthorization, completeCallback, syncSession } from './flow.js';
import {
  listAccounts,
  latestBalances,
  recentSyncLog,
} from './store.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function html(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Enable Banking — Finance Tracker</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;color:#e8ecff;background:#0b1020}
  a.btn{display:inline-block;background:#4361ee;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600}
  a.btn:hover{background:#3a53d0}
  code,pre{background:#161c34;padding:2px 6px;border-radius:4px}
  pre{padding:12px;overflow:auto}
  table{border-collapse:collapse;width:100%;margin:12px 0}
  th,td{border:1px solid #2a3153;padding:6px 10px;text-align:left;font-size:13px}
  th{background:#161c34}
  .ok{color:#5ee6a8}.warn{color:#ffcf6b}.muted{color:#8b93b8}
  h1,h2{font-family:"Space Grotesk",system-ui,sans-serif}
</style>
${body}`);
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj, null, 2));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

// Build the status-page HTML string (kept separate from response writing).
function renderStatus(db, opts) {
  const accounts = listAccounts(db);
  const balances = latestBalances(db);
  const log = recentSyncLog(db, 10);
  const balByUid = Object.fromEntries(balances.map((b) => [b.account_uid, b]));

  const banner = opts?.connected
    ? `<p class="ok"><strong>Connected.</strong> Accounts, balances and transactions were pulled from the sandbox and stored in finance.db.</p>`
    : opts?.error
    ? `<p class="warn"><strong>Problem:</strong> ${esc(opts.error)}</p>`
    : '';

  const acctRows = accounts.length
    ? accounts
        .map((a) => {
          const b = balByUid[a.uid];
          return `<tr>
            <td>${esc(a.name || a.product || '(account)')}<br><span class="muted">${esc(a.uid)}</span></td>
            <td>${esc(a.iban || '—')}</td>
            <td>${b ? esc(b.amount) + ' ' + esc(b.currency || a.currency || '') + ' <span class="muted">(' + esc(b.balance_type || '') + ')</span>' : '<span class="muted">—</span>'}</td>
            <td>${esc(a.entries_account)}</td>
            <td>${esc(a.last_synced_at || 'never')}</td>
          </tr>`;
        })
        .join('')
    : `<tr><td colspan="5" class="muted">No accounts yet — connect the sandbox bank.</td></tr>`;

  const logRows = log.length
    ? log
        .map(
          (l) => `<tr>
            <td>${esc(l.ran_at)}</td>
            <td><span class="muted">${esc(l.account_uid)}</span></td>
            <td>${esc(l.fetched)} fetched / <span class="ok">${esc(l.inserted)} new</span> / ${esc(l.skipped)} dup</td>
            <td>${l.balance_amount == null ? '—' : esc(l.balance_amount) + ' ' + esc(l.balance_currency || '')}</td>
            <td class="warn">${esc(l.note || '')}</td>
          </tr>`
        )
        .join('')
    : `<tr><td colspan="5" class="muted">No syncs yet.</td></tr>`;

  return `<h1>Enable Banking <span class="muted">— ${esc(EB.aspspName)} · ${esc(EB.aspspCountry)} · SANDBOX</span></h1>
${banner}
<p><a class="btn" href="/eb/connect">Connect sandbox bank</a>
&nbsp; <a class="btn" style="background:#2a3153" href="/eb/refresh">Refresh data</a></p>
<p class="muted">Read-only (Account Information only). Redirect URL: <code>${esc(EB.redirectUrl)}</code></p>

<h2>Accounts &amp; balances</h2>
<table><tr><th>Account</th><th>IBAN</th><th>Latest balance</th><th>entries.account</th><th>Last synced</th></tr>${acctRows}</table>

<h2>Recent syncs</h2>
<table><tr><th>When (UTC)</th><th>Account</th><th>Transactions</th><th>Balance seen</th><th>Note</th></tr>${logRows}</table>

<p class="muted">JSON views: <a href="/eb/status">/eb/status</a> · <a href="/eb/application">/eb/application</a> · <a href="/eb/aspsps?country=${esc(EB.aspspCountry)}">/eb/aspsps</a></p>`;
}

// Returns true if it handled the request.
export async function handleEb(req, res, url, db) {
  const p = url.pathname;
  if (p !== '/callback' && p !== '/eb' && !p.startsWith('/eb/')) return false;
  if (req.method !== 'GET') {
    html(res, 405, '<h1>405</h1><p>GET only.</p>');
    return true;
  }

  try {
    if (p === '/eb') {
      html(res, 200, renderStatus(db, { connected: url.searchParams.get('connected') === '1' }));
      return true;
    }

    if (p === '/eb/connect') {
      const { url: authUrl } = await beginAuthorization(db);
      redirect(res, authUrl);
      return true;
    }

    if (p === '/callback' || p === '/eb/callback') {
      const err = url.searchParams.get('error');
      if (err) {
        const desc = url.searchParams.get('error_description');
        html(res, 400, renderStatus(db, { error: `bank returned "${err}"${desc ? ': ' + desc : ''}` }));
        return true;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state) {
        html(res, 400, renderStatus(db, {
          error: 'callback is missing "code" or "state" — open /eb and start with "Connect sandbox bank"',
        }));
        return true;
      }
      const summary = await completeCallback(db, { code, state });
      console.log('[eb] callback synced:', JSON.stringify(summary));
      redirect(res, '/eb?connected=1');
      return true;
    }

    if (p === '/eb/status') {
      json(res, 200, {
        aspsp: { name: EB.aspspName, country: EB.aspspCountry },
        redirect_url: EB.redirectUrl,
        accounts: listAccounts(db),
        latest_balances: latestBalances(db),
        sync_log: recentSyncLog(db, 25),
      });
      return true;
    }

    if (p === '/eb/application') {
      json(res, 200, await getApplication());
      return true;
    }

    if (p === '/eb/aspsps') {
      const country = url.searchParams.get('country') || undefined;
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const resp = await listAspsps(country ? { country } : {});
      let list = resp.aspsps || resp || [];
      if (q) list = list.filter((a) => String(a.name).toLowerCase().includes(q));
      json(res, 200, { count: list.length, aspsps: list });
      return true;
    }

    if (p === '/eb/refresh') {
      const last = db
        .prepare('SELECT session_id FROM eb_sessions ORDER BY created_at DESC LIMIT 1')
        .get();
      if (!last) {
        html(res, 400, renderStatus(db, { error: 'no session yet — connect first' }));
        return true;
      }
      const summary = await syncSession(db, last.session_id);
      console.log('[eb] refresh synced:', JSON.stringify(summary));
      redirect(res, '/eb?connected=1');
      return true;
    }

    html(res, 404, '<h1>404</h1>');
    return true;
  } catch (e) {
    console.error('[eb] route error:', e);
    html(res, e.status || 500, renderStatus(db, { error: e.message }));
    return true;
  }
}
