// server.js — zero-dependency HTTP server: JSON API + static frontend.
// Binds to localhost only. Later this can sit behind Tailscale unchanged.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, HttpError } from './db.js';
import { migrate as ebMigrate } from './eb/store.js';
import { handleEb } from './eb/routes.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || join(ROOT, 'finance.db');

const db = openDb(DB_PATH);
// Enable Banking integration: add entries.external_id + eb_* sidecar tables.
ebMigrate(db.raw);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new HttpError(413, 'body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new HttpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// ---- API routes ----------------------------------------------------------

const routes = [
  ['GET', /^\/api\/health$/, () => ({ ok: true, now: new Date().toISOString() })],

  ['GET', /^\/api\/entries$/, (_b, _p, q) =>
    db.listEntries({
      from: q.get('from') || undefined,
      to: q.get('to') || undefined,
      type: q.get('type') || undefined,
      account: q.get('account') || undefined,
      category: q.get('category') || undefined,
      recurringOnly: q.get('recurringOnly') === '1' || q.get('recurringOnly') === 'true',
      limit: q.get('limit') || undefined,
    }),
  ],
  ['POST', /^\/api\/entries$/, (b) => db.createEntry(b), 201],
  ['GET', /^\/api\/entries\/(\d+)$/, (_b, p) => db.getEntry(Number(p[1]))],
  ['PATCH', /^\/api\/entries\/(\d+)$/, (b, p) => db.updateEntry(Number(p[1]), b)],
  ['PUT', /^\/api\/entries\/(\d+)$/, (b, p) => db.updateEntry(Number(p[1]), b)],
  ['DELETE', /^\/api\/entries\/(\d+)$/, (_b, p) => db.deleteEntry(Number(p[1]))],

  ['GET', /^\/api\/recurring$/, (_b, _p, q) =>
    db.listRules({ activeOnly: q.get('activeOnly') === '1' }),
  ],
  ['POST', /^\/api\/recurring$/, (b) => db.createRule(b), 201],
  ['GET', /^\/api\/recurring\/due$/, (_b, _p, q) => db.dueOccurrences(q.get('ref') || undefined)],
  ['POST', /^\/api\/recurring\/materialize$/, (b) =>
    db.materialize(b.selections || [], b.ref || undefined),
  ],
  ['PATCH', /^\/api\/recurring\/(\d+)$/, (b, p) => db.updateRule(Number(p[1]), b)],
  ['PUT', /^\/api\/recurring\/(\d+)$/, (b, p) => db.updateRule(Number(p[1]), b)],
  ['DELETE', /^\/api\/recurring\/(\d+)$/, (_b, p) => db.deleteRule(Number(p[1]))],

  ['GET', /^\/api\/summary$/, (_b, _p, q) => db.summary(q.get('ref') || undefined)],
];

async function handleApi(req, res, url) {
  for (const [method, pattern, fn, okStatus] of routes) {
    if (req.method !== method) continue;
    const m = url.pathname.match(pattern);
    if (!m) continue;
    const body = ['POST', 'PATCH', 'PUT'].includes(method) ? await readJsonBody(req) : {};
    const result = fn(body, m, url.searchParams);
    return send(res, okStatus || 200, result ?? {});
  }
  throw new HttpError(404, 'no such endpoint: ' + req.method + ' ' + url.pathname);
}

// ---- static files ------------------------------------------------------

async function handleStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const path = normalize(join(PUBLIC, rel));
  if (!path.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
  try {
    const file = await readFile(path);
    send(res, 200, file, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
  } catch {
    send(res, 404, 'not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else if (await handleEb(req, res, url, db.raw)) {
      // Enable Banking routes (/eb, /eb/*, /callback) handled it.
    } else if (req.method === 'GET') {
      await handleStatic(req, res, url);
    } else {
      send(res, 405, 'method not allowed');
    }
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    send(res, status, { error: err.message || 'internal error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Finance tracker running at http://${HOST}:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
