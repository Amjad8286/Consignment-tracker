#!/usr/bin/env node
/**
 * Netlify build step: writes the static site to dist/.
 *
 * Published: every *.html page in the project folder (index.html, about.html, contact.html, …), the
 * assets/ folder, and robots.txt / sitemap.xml. server.js serves the same set locally, so server.js,
 * relay.js and the README are not exposed as files.
 *
 * index.html points at a local relay through <meta name="awb-relay" content="http://localhost:3000">,
 * which is what lets it work from file:// or VS Code Live Server. On Netlify the page and the
 * function share one origin, so the address is blanked ("" = call /api/track on this same site).
 * server.js does the same when it serves the page itself.
 * Fails (non-zero exit) rather than publishing a page that would call localhost.
 *
 * It also warns (without failing the build) about any [Placeholder] still in a page, such as
 * "[Support Email]", so it doesn't reach the live site unnoticed. See README → "Before you go live".
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist');
const assets = path.join(root, 'assets');
const META = /(<meta\s+name="awb-relay"\s+content=")[^"]*(")/i;
const PAGE = /^[a-z0-9-]+\.html$/;
const ROOT_FILES = ['robots.txt', 'sitemap.xml']; // search-engine files that must sit at the site root
// Business details the About, Contact, Disclaimer, Privacy Policy and Terms pages ask you to fill in.
const PLACEHOLDER = /\[(?:Business Name|Support Email|Phone Number|Business Address|Business Hours|City|Grievance Officer Name)\]/g;

function fail(message) {
  console.error(`build-netlify: ${message}`);
  process.exit(1);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // .DS_Store and friends
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest); else fs.copyFileSync(src, dest);
  }
}

// Read and check everything first, so a problem leaves the previous dist/ untouched.
const names = fs.readdirSync(root).filter((f) => PAGE.test(f)).sort();
if (!names.includes('index.html')) fail('index.html not found.');
if (!fs.existsSync(assets)) fail('assets/ not found, but the pages link to its CSS and JS.');

const pages = names.map((name) => ({ name, html: fs.readFileSync(path.join(root, name), 'utf8') }));
const index = pages.find((p) => p.name === 'index.html');
if (!META.test(index.html)) {
  fail('<meta name="awb-relay" …> not found in index.html, so the relay address cannot be blanked.');
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const todo = new Map(); // placeholder → pages that still contain it
for (const { name, html } of pages) {
  fs.writeFileSync(path.join(out, name), html.replace(META, '$1$2'));
  for (const token of new Set(html.match(PLACEHOLDER) || [])) todo.set(token, [...(todo.get(token) || []), name]);
}
copyDir(assets, path.join(out, 'assets'));
for (const file of ROOT_FILES) if (fs.existsSync(path.join(root, file))) fs.copyFileSync(path.join(root, file), path.join(out, file));

console.log(`build-netlify: wrote dist/ (${pages.length} pages + assets/; relay address blanked → same-origin /api/track)`);
if (todo.size) {
  console.warn('build-netlify: WARNING: placeholders still to fill in before going live:');
  for (const [token, files] of todo) console.warn(`    ${token.padEnd(24)} ${files.join(', ')}`);
}
