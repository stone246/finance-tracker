// eb/config.js — Enable Banking integration configuration.
//
// READ-ONLY (Account Information Services) integration. This project never
// initiates payments. See eb/README.md.
//
// Nothing secret lives here. The private key is read from a file under
// secrets/ (git-ignored); its path and the app id can be overridden by env.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const EB = {
  // Enable Banking application id (public identifier — used as the JWT `kid`).
  applicationId:
    process.env.EB_APPLICATION_ID || '694ed911-3539-43f8-a464-14c6692835c9',

  // PEM file with the RSA private key registered for the application above.
  privateKeyPath:
    process.env.EB_PRIVATE_KEY_PATH ||
    join(ROOT, 'secrets', '694ed911-3539-43f8-a464-14c6692835c9.pem'),

  // API host. api.tilisy.com is the deprecated alias.
  apiBase: process.env.EB_API_BASE || 'https://api.enablebanking.com',

  // JWT lifetime in seconds (Enable Banking hard limit is 86400).
  jwtTtlSeconds: Number(process.env.EB_JWT_TTL || 3600),

  // Sandbox target ASPSP. The mock bank ("fake test data") is the default.
  // Correct these from `GET /eb/aspsps` if the sandbox lists them differently.
  aspspName: process.env.EB_ASPSP_NAME || 'Mock ASPSP',
  aspspCountry: process.env.EB_ASPSP_COUNTRY || 'FI',

  // Payment services unit / PSU type: "personal" or "business".
  psuType: process.env.EB_PSU_TYPE || 'personal',

  // Where the bank sends the user back after consent. Must be one of the
  // redirect URLs registered on the Enable Banking application.
  // `GET /eb/application` prints the registered list.
  // Must byte-match a redirect URL registered on the application. The
  // sandbox app "Finances" currently registers exactly this one.
  redirectUrl:
    process.env.EB_REDIRECT_URL || 'http://localhost:3000/callback',

  // How far back to pull transactions on the first import (days).
  transactionsSinceDays: Number(process.env.EB_TX_SINCE_DAYS || 90),

  // Consent validity window requested in POST /auth (days).
  consentValidDays: Number(process.env.EB_CONSENT_DAYS || 10),

  // Every fetched account is written to `entries` with this account label,
  // which must satisfy the entries CHECK constraint (Cash|Revolut|Bank).
  entriesAccountLabel: process.env.EB_ENTRIES_ACCOUNT || 'Bank',
};

// Guard rail for requirement: this integration is READ-ONLY, permanently.
// If a code path ever asks the client for a payments endpoint, fail loudly.
export function assertReadOnlyPath(path) {
  if (/payment/i.test(path)) {
    throw new Error(
      `Refusing request to "${path}": this integration is Account Information ` +
        `only. Payment initiation is intentionally not implemented.`
    );
  }
}
