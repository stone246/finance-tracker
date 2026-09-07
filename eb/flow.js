// eb/flow.js — orchestrates the Account Information flow end to end.
//
//   beginAuthorization  -> build consent URL, remember `state`
//   completeCallback    -> exchange `code`, create session, sync every account
//   syncSession         -> re-pull balances + transactions for a known session
//
// "Sync" is strictly read: GET account details / balances / transactions,
// then write the results into the local database.

import { randomUUID } from 'node:crypto';
import { EB } from './config.js';
import { today, addDays } from '../dates.js';
import {
  startAuthorization,
  createSession,
  getSession,
  getAccountDetails,
  getAccountBalances,
  getAccountTransactions,
} from './client.js';
import * as store from './store.js';

function validUntilIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Step 1 — start the consent. Returns { url, authorization_id, state }.
export async function beginAuthorization(db) {
  const state = randomUUID();
  const auth = await startAuthorization({
    state,
    validUntil: validUntilIso(EB.consentValidDays),
  });
  store.saveAuthState(db, { state, authorizationId: auth.authorization_id });
  return { url: auth.url, authorization_id: auth.authorization_id, state };
}

// Step 2 — the bank redirected back with ?code=&state=. Verify, exchange,
// persist the session, then sync each account it exposes.
export async function completeCallback(db, { code, state }) {
  if (!code) {
    const e = new Error('callback missing "code"');
    e.status = 400;
    throw e;
  }
  if (!state || !store.consumeAuthState(db, state)) {
    const e = new Error('callback "state" is unknown, already used, or forged');
    e.status = 400;
    throw e;
  }
  const session = await createSession(code);
  store.saveSession(db, session);

  const results = [];
  for (const account of session.accounts || []) {
    results.push(await syncAccount(db, account, session.session_id));
  }
  return {
    session_id: session.session_id,
    aspsp: session.aspsp,
    valid_until: session.access?.valid_until,
    accounts: results,
  };
}

// Re-pull data for the accounts of an existing session.
export async function syncSession(db, sessionId) {
  const session = await getSession(sessionId);
  const results = [];
  for (const account of session.accounts || []) {
    const acc = typeof account === 'string' ? { uid: account } : account;
    results.push(await syncAccount(db, acc, sessionId));
  }
  return { session_id: sessionId, accounts: results };
}

// Sync one account: details -> balances -> transactions -> store.
export async function syncAccount(db, account, sessionId) {
  const uid = account.uid;
  const entriesAccount = EB.entriesAccountLabel;

  let details = null;
  try {
    details = await getAccountDetails(uid);
  } catch (e) {
    details = { _error: e.message };
  }
  store.upsertAccount(db, { account, sessionId, entriesAccount, details });

  const balancesResp = await getAccountBalances(uid);
  const balances = balancesResp.balances || balancesResp || [];
  const savedBalances = store.saveBalances(db, uid, balances);
  const headline = store.pickHeadlineBalance(balances);

  const dateFrom = addDays(today(), -EB.transactionsSinceDays);
  const dateTo = today();
  const all = [];
  let continuationKey;
  for (let page = 0; page < 25; page++) {
    const resp = await getAccountTransactions(uid, {
      dateFrom,
      dateTo,
      continuationKey,
    });
    const batch = resp.transactions || [];
    all.push(...batch);
    continuationKey = resp.continuation_key;
    if (!continuationKey || batch.length === 0) break;
  }

  const imported = store.importTransactions(db, uid, all, entriesAccount);
  store.markAccountSynced(db, uid);

  const headlineAmount = headline
    ? Number(headline.balance_amount?.amount ?? headline.amount ?? 0)
    : null;
  const headlineCurrency = headline
    ? headline.balance_amount?.currency ?? headline.currency ?? null
    : null;

  store.logSync(db, {
    account_uid: uid,
    tx_from: dateFrom,
    tx_to: dateTo,
    fetched: imported.fetched,
    inserted: imported.inserted,
    skipped: imported.skipped,
    balance_amount: headlineAmount,
    balance_currency: headlineCurrency,
    note: details?._error ? `details error: ${details._error}` : null,
  });

  return {
    uid,
    name: account.name ?? details?.name ?? null,
    iban:
      account.account_id?.iban ??
      details?.account_id?.iban ??
      null,
    currency: account.currency ?? details?.currency ?? null,
    balances: savedBalances,
    headline_balance:
      headlineAmount === null
        ? null
        : { amount: headlineAmount, currency: headlineCurrency, type: headline.balance_type },
    transactions: {
      fetched: imported.fetched,
      inserted: imported.inserted,
      skipped_as_duplicate: imported.skipped,
      window: { from: dateFrom, to: dateTo },
    },
  };
}
