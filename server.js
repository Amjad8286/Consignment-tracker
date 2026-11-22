#!/usr/bin/env node
/**
 * AWB Tracker — local relay for Shree Tirupati Courier's public AWB search.
 *
 * WHY THIS FILE EXISTS
 *   shreetirupaticourier.net sends no CORS headers, so a page running on
 *   localhost or file:// is not allowed to read its responses. This server
 *   repeats exactly what the website's own "Enter AWB No. → GO" box does,
 *   then hands the result to index.html as JSON. It does not call any new
 *   or private endpoint and does not change anything on the courier's side.
 *
 * The courier logic (search, parsing, validation) lives in relay.js, which is shared with the
 * Netlify Function in netlify/functions/. This file only adds the local HTTP server around it,
 * and serves the site's pages and assets/ so the whole site works at http://localhost:3000.
 *
 * USAGE
 *   node server.js            → open http://localhost:3000
 *   PORT=8080 node server.js  → custom port
 *   Requires Node.js 18+. No npm install needed.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const relay = require('./relay');
const { UPSTREAM, trackRequest } = relay;

// ───────────────────────────── configuration ─────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

// What is public: the *.html pages in this folder and the files in assets/. Nothing else is served,
// so server.js, relay.js and the README stay private. (scripts/build-netlify.js publishes the same set.)
const ROOT = __dirname;
const ASSETS_DIR = path.join(ROOT, 'assets');
const PAGE_PATH = /^\/([a-z0-9-]+)\.html$/;
const ASSET_PATH = /^\/assets\/([\w.-]+)$/;
const ROOT_FILES = { // the two files search engines look for at the site root
  '/robots.txt': 'text/plain; charset=utf-8',
  '/sitemap.xml': 'application/xml; charset=utf-8',
};
const ASSET_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const MAX_FORM_BYTES = 32 * 1024;

// ───────────────────────────── HTTP server ─────────────────────────────
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function applyCors(req, res) {
  // Allow index.html opened from file:// (Origin "null") or any localhost port.
  const origin = req.headers.origin;
  if (origin && (origin === 'null' || LOCAL_ORIGIN.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const apiError = (res, status, code, message, extra = {}) =>
  sendJson(res, status, { ok: false, error: { code, message, ...extra } });

async function handleTrack(req, res, url) {
  const { status, body } = await trackRequest(url.searchParams.get('awb'));
  sendJson(res, status, body);
}

function servePage(res, file) {
  fs.readFile(path.join(ROOT, file), (err, data) => {
    if (err) {
      return file === 'index.html'
        ? apiError(res, 500, 'MISSING_INDEX', 'index.html was not found next to server.js.')
        : apiError(res, 404, 'NOT_FOUND', 'Not found.');
    }
    // Served by the relay itself → the page calls /api/* on this same origin, whatever the port.
    const html = data.toString('utf8').replace(/(<meta\s+name="awb-relay"\s+content=")[^"]*(")/i, '$1$2');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html);
  });
}

function sendFile(res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) return apiError(res, 404, 'NOT_FOUND', 'Not found.');
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': data.length });
    res.end(data);
  });
}

function serveAsset(res, name) {
  const file = path.join(ASSETS_DIR, name);
  const type = ASSET_TYPES[path.extname(name).toLowerCase()];
  if (!type || path.dirname(file) !== ASSETS_DIR) return apiError(res, 404, 'NOT_FOUND', 'Not found.');
  sendFile(res, file, type);
}

// The contact form (contact.html) is collected by Netlify Forms once deployed (see README). There is no
// mail service locally, so this only checks that a submission arrives and prints it. That lets you try
// the form end to end with `node server.js`. Nothing is stored or sent anywhere.
function handleContactPost(req, res) {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => { size += chunk.length; if (size <= MAX_FORM_BYTES) chunks.push(chunk); });
  req.on('end', () => {
    if (size > MAX_FORM_BYTES) return apiError(res, 413, 'TOO_LARGE', 'That message is too large.');
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    if (form.get('form-name') !== 'contact') return apiError(res, 400, 'UNKNOWN_FORM', 'Unknown form.');
    if (!form.get('bot-field')) { // the honeypot: a filled-in hidden field means a bot, which Netlify would also drop
      form.delete('form-name');
      form.delete('bot-field');
      console.log('Contact form (local test, not delivered anywhere):', Object.fromEntries(form));
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Received (local test).');
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const started = Date.now();
  res.on('finish', () => {
    const q = url.searchParams.get('awb');
    console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}${q ? ' awb=' + q : ''} → ${res.statusCode} (${Date.now() - started} ms)`);
  });

  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  if (req.method === 'POST' && !url.pathname.startsWith('/api/')) return handleContactPost(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET is supported.');

  if (url.pathname === '/api/track') return handleTrack(req, res, url);
  if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, upstream: UPSTREAM });

  if (url.pathname === '/') return servePage(res, 'index.html');
  const page = PAGE_PATH.exec(url.pathname);
  if (page) return servePage(res, `${page[1]}.html`);
  const asset = ASSET_PATH.exec(url.pathname);
  if (asset) return serveAsset(res, asset[1]);
  if (ROOT_FILES[url.pathname]) return sendFile(res, path.join(ROOT, url.pathname), ROOT_FILES[url.pathname]);
  if (url.pathname === '/favicon.ico') return res.writeHead(204).end();
  return apiError(res, 404, 'NOT_FOUND', 'Not found.');
});

if (require.main === module) {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Try: PORT=3001 node server.js`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`AWB Tracker running → http://localhost:${PORT}`);
    console.log(`Relaying searches to ${UPSTREAM}`);
  });
}

module.exports = { ...relay, server };