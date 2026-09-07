// eb/jwt.js — RS256 JWT for Enable Banking, using node:crypto only.
//
// Header:  { typ: "JWT", alg: "RS256", kid: <application id> }
// Payload: { iss: "enablebanking.com", aud: "api.enablebanking.com", iat, exp }
// Signed with the application's RSA private key. Sent as `Authorization: Bearer`.

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { EB } from './config.js';

const b64url = (buf) =>
  Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

let _key = null;
function privateKey() {
  if (_key) return _key;
  try {
    _key = readFileSync(EB.privateKeyPath, 'utf8');
  } catch (e) {
    throw new Error(
      `Cannot read Enable Banking private key at ${EB.privateKeyPath}: ${e.message}`
    );
  }
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(_key)) {
    throw new Error(`File at ${EB.privateKeyPath} is not a PEM private key`);
  }
  return _key;
}

// Build a fresh signed JWT valid for EB.jwtTtlSeconds.
export function signJwt({ now = Math.floor(Date.now() / 1000) } = {}) {
  const ttl = Math.min(EB.jwtTtlSeconds, 86400);
  const header = { typ: 'JWT', alg: 'RS256', kid: EB.applicationId };
  const payload = {
    iss: 'enablebanking.com',
    aud: 'api.enablebanking.com',
    iat: now,
    exp: now + ttl,
  };
  const signingInput =
    b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .sign(privateKey());
  return {
    token: signingInput + '.' + b64url(signature),
    expiresAt: (now + ttl) * 1000,
  };
}

// Cached accessor — re-signs ~1 minute before expiry.
let _cached = null;
export function getJwt() {
  const nowMs = Date.now();
  if (_cached && _cached.expiresAt - nowMs > 60_000) return _cached.token;
  _cached = signJwt();
  return _cached.token;
}
