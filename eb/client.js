// eb/client.js — minimal HTTP client for the Enable Banking API.
// Adds the bearer JWT, JSON-encodes, and throws a useful error on non-2xx.
// A hard guard rejects any payments path: this integration is AIS-only.

import { EB, assertReadOnlyPath } from './config.js';
import { getJwt } from './jwt.js';

export class EbApiError extends Error {
  constructor(status, path, body) {
    const detail =
      body && typeof body === 'object' ? JSON.stringify(body) : String(body);
    super(`Enable Banking ${status} on ${path}: ${detail}`);
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

async function request(method, path, { query, body, psuHeaders } = {}) {
  assertReadOnlyPath(path);
  const url = new URL(EB.apiBase + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }
  const headers = {
    Authorization: `Bearer ${getJwt()}`,
    Accept: 'application/json',
    ...(psuHeaders || {}),
  };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) throw new EbApiError(res.status, path, parsed);
  return parsed;
}

export const ebGet = (path, opts) => request('GET', path, opts);
export const ebPost = (path, opts) => request('POST', path, opts);

// ---- typed helpers -------------------------------------------------------

// Application metadata, including the registered redirect URLs.
export const getApplication = () => ebGet('/application');

// Available ASPSPs (banks). In sandbox this includes the mock bank.
export const listAspsps = (params = {}) => ebGet('/aspsps', { query: params });

// Start an authorization. Returns { url, authorization_id, psu_id_hash }.
// The `access` object carries only a validity window — Account Information
// access. No payment scope is requested.
export function startAuthorization({ state, validUntil }) {
  return ebPost('/auth', {
    body: {
      access: { valid_until: validUntil },
      aspsp: { name: EB.aspspName, country: EB.aspspCountry },
      state,
      redirect_url: EB.redirectUrl,
      psu_type: EB.psuType,
    },
  });
}

// Exchange the `code` from the redirect for a session.
// Returns { session_id, accounts: [...], aspsp, access, ... }.
export const createSession = (code) => ebPost('/sessions', { body: { code } });

export const getSession = (sessionId) => ebGet(`/sessions/${sessionId}`);

// Read-only account data.
export const getAccountDetails = (uid) => ebGet(`/accounts/${uid}/details`);
export const getAccountBalances = (uid) => ebGet(`/accounts/${uid}/balances`);
export function getAccountTransactions(uid, { dateFrom, dateTo, continuationKey } = {}) {
  return ebGet(`/accounts/${uid}/transactions`, {
    query: {
      date_from: dateFrom,
      date_to: dateTo,
      continuation_key: continuationKey,
    },
  });
}
