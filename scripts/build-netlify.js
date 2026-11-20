#!/usr/bin/env node
/**
 * Netlify build step: writes the static site to dist/.
 *
 * index.html points at a local relay through <meta name="awb-relay" content="http://localhost:3000">,
 * which is what lets it work from file:// or VS Code Live Server. On Netlify the page and the
 * function share one origin, so the address is blanked ("" = call /api/track on this same site).
 * server.js does the same when it serves the page itself.
 *
 * Only index.html is published, so server.js, relay.js and the README are not exposed as files.
 * Fails (non-zero exit) rather than publishing a page that would call localhost.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist');
const META = /(<meta\s+name="awb-relay"\s+content=")[^"]*(")/i;

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
if (!META.test(html)) {
  console.error('build-netlify: <meta name="awb-relay" …> not found in index.html, so the relay address cannot be blanked.');
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html.replace(META, '$1$2'));
console.log('build-netlify: wrote dist/index.html (relay address blanked → same-origin /api/track)');
