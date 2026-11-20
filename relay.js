/**
 * AWB Tracker — the courier-facing logic, shared by every way of running the relay.
 *
 * It repeats exactly what shreetirupaticourier.net's own "Enter AWB No. → GO" box does and
 * returns the result as plain objects. It has no HTTP server, file or Node-only dependencies
 * (it needs only fetch/URL, available in Node 18+), so the same code runs in:
 *   - server.js                       → local relay:   node server.js
 *   - netlify/functions/track.mjs     → Netlify Function (serverless)
 *
 * UPSTREAM FLOW (observed on the live site, Nov 2026)
 *   1. GET  /TopHeader.aspx
 *        → hidden fields __VIEWSTATE, __VIEWSTATEGENERATOR, __EVENTVALIDATION
 *   2. POST /TopHeader.aspx   (application/x-www-form-urlencoded)
 *        trackingno=<AWB[,AWB…]>  btnTrack=Go  networksearch=  + the 3 hidden fields
 *        → 302 to /Frm_DocList.aspx?docnos=<server-encrypted list>
 *   3. Frm_DocList.aspx contains one link per AWB:
 *        <a href="Frm_DocTrackWeb.aspx?docno=<encrypted>&Tmp=<n>" target="I1">171100087119</a>
 *   4. GET  /Frm_DocTrackWeb.aspx?docno=…
 *        → span#lblDocNumber, #txtFromCenter, #txtToCenter, #txtDate,
 *          #txtReceiver, #lblStatus and table#tblTrack (history, often empty)
 *   No login, API key, token header or session cookie is required.
 *   The docno/docnos tokens are encrypted by the server, so steps 1–2 cannot be skipped.
 */
'use strict';

// ───────────────────────────── configuration ─────────────────────────────
const UPSTREAM = (process.env.UPSTREAM || 'https://www.shreetirupaticourier.net').replace(/\/+$/, '');
const UPSTREAM_HOST = new URL(UPSTREAM).hostname;
const UPSTREAM_TIMEOUT_MS = 20000;
const FORM_STATE_TTL_MS = 10 * 60 * 1000; // reuse ViewState for 10 min, refresh on failure
const MAX_AWBS = 25;
const DETAIL_CONCURRENCY = 4;
const AWB_PATTERN = /^\d{12}$/; // the site's own rule: 12 digits, comma-separated for many
const USER_AGENT = 'Mozilla/5.0 (compatible; LocalAWBTracker/1.0)';

class UpstreamError extends Error {
  constructor(message, status = 502, code = 'UPSTREAM_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ───────────────────────────── HTML helpers ─────────────────────────────
// The upstream markup is small and stable (fixed element ids), so a few
// targeted regexes are enough; no HTML-parser dependency is needed.
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(str) {
  return String(str).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ent) => {
    if (ent[0] === '#') {
      const code = ent[1].toLowerCase() === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    const value = NAMED_ENTITIES[ent.toLowerCase()];
    return value !== undefined ? value : match;
  });
}

function htmlToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Inner HTML of the first <tag id="id">…</tag>, or null when absent. */
function innerById(html, tag, id) {
  const re = new RegExp(
    '<' + tag + '\\b[^>]*\\bid\\s*=\\s*["\']' + escapeRegExp(id) + '["\'][^>]*>([\\s\\S]*?)</' + tag + '\\s*>',
    'i'
  );
  const m = html.match(re);
  return m ? m[1] : null;
}

/** value="" of <input name="…">, or null when the input is absent. */
function inputValue(html, name) {
  const re = new RegExp('<input\\b[^>]*\\bname\\s*=\\s*["\']' + escapeRegExp(name) + '["\'][^>]*>', 'i');
  const tag = (html.match(re) || [])[0];
  if (!tag) return null;
  const v = tag.match(/\bvalue\s*=\s*"([^"]*)"/i) || tag.match(/\bvalue\s*=\s*'([^']*)'/i);
  return v ? decodeEntities(v[1]) : '';
}

// ───────────────────────────── upstream I/O ─────────────────────────────
/** Resolve a link from upstream HTML and make sure it stays on the courier's host. */
function toUpstreamUrl(href, base = UPSTREAM + '/') {
  const url = new URL(href, base);
  if (url.hostname !== UPSTREAM_HOST) {
    throw new UpstreamError(`Unexpected redirect to another host (${url.hostname}).`);
  }
  url.protocol = new URL(UPSTREAM).protocol;
  return url.href;
}

function mergeCookies(response, existing = '') {
  const jar = new Map();
  for (const part of existing.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i), part.slice(i + 1));
  }
  const setCookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
  for (const c of setCookies) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function upstreamFetch(target, { method = 'GET', body, cookie, referer, redirect = 'follow' } = {}) {
  const url = toUpstreamUrl(target);
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-IN,en;q=0.9',
  };
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (cookie) headers.Cookie = cookie;
  if (referer) headers.Referer = referer;
  try {
    return await fetch(url, { method, body, headers, redirect, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new UpstreamError('The courier website took too long to respond. Please try again.', 504, 'UPSTREAM_TIMEOUT');
    }
    const reason = (err.cause && (err.cause.code || err.cause.message)) || err.message;
    throw new UpstreamError(`Could not reach the courier website (${reason}).`, 502, 'UPSTREAM_UNREACHABLE');
  }
}

// Step 1 — ASP.NET WebForms rejects the postback without these hidden fields.
let formStateCache = null;

async function getFormState(forceRefresh = false) {
  if (!forceRefresh && formStateCache && Date.now() - formStateCache.at < FORM_STATE_TTL_MS) {
    return formStateCache;
  }
  const res = await upstreamFetch('/TopHeader.aspx');
  if (!res.ok) throw new UpstreamError(`Search form returned HTTP ${res.status}.`);
  const html = await res.text();
  const fields = {};
  for (const name of ['__VIEWSTATE', '__VIEWSTATEGENERATOR', '__EVENTVALIDATION']) {
    const value = inputValue(html, name);
    if (value !== null) fields[name] = value;
  }
  if (!fields.__VIEWSTATE) {
    throw new UpstreamError('The courier website changed its search form (no __VIEWSTATE found).', 502, 'UPSTREAM_CHANGED');
  }
  formStateCache = { fields, cookie: mergeCookies(res), at: Date.now() };
  return formStateCache;
}

// Step 2 — submit the same form the header search box submits.
async function submitSearch(awbs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await getFormState(attempt > 0);
    const form = new URLSearchParams({
      ...state.fields,
      trackingno: awbs.join(','),
      btnTrack: 'Go',
      networksearch: '',
    });
    const res = await upstreamFetch('/TopHeader.aspx', {
      method: 'POST',
      body: form.toString(),
      cookie: state.cookie,
      referer: UPSTREAM + '/TopHeader.aspx',
      redirect: 'manual',
    });
    const location = res.headers.get('location');
    await res.arrayBuffer().catch(() => {}); // drain the body

    if (res.status >= 300 && res.status < 400 && location) {
      const listUrl = toUpstreamUrl(location, UPSTREAM + '/TopHeader.aspx');
      if (!/\/Frm_DocList\.aspx$/i.test(new URL(listUrl).pathname)) {
        throw new UpstreamError('The courier website redirected the search to an unexpected page.', 502, 'UPSTREAM_CHANGED');
      }
      const cookie = mergeCookies(res, state.cookie);
      // Step 3 — the AWB list page.
      const listRes = await upstreamFetch(listUrl, { cookie, referer: UPSTREAM + '/TopHeader.aspx' });
      if (!listRes.ok) throw new UpstreamError(`AWB list page returned HTTP ${listRes.status}.`);
      return { listUrl, cookie, html: await listRes.text() };
    }
    // No redirect: almost always a stale ViewState → refresh it and retry once.
  }
  throw new UpstreamError('The courier website did not accept the search request.', 502, 'UPSTREAM_REJECTED');
}

// ───────────────────────────── parsing ─────────────────────────────
/** Links in Frm_DocList.aspx that load a detail page into the "I1" iframe. */
function parseDocList(html, baseUrl) {
  const links = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let m;
  while ((m = anchorRe.exec(html))) {
    const attrs = m[1];
    if (!/\btarget\s*=\s*["']?I1["'\s>]/i.test(attrs + ' ')) continue;
    const href = (attrs.match(/\bhref\s*=\s*"([^"]*)"/i) || attrs.match(/\bhref\s*=\s*'([^']*)'/i) || [])[1];
    if (!href) continue;
    links.push({ awb: htmlToText(m[2]).replace(/\s+/g, ''), detailUrl: toUpstreamUrl(decodeEntities(href), baseUrl) });
  }
  return links;
}

const HISTORY_HEADER_WORDS = /^(s\.?\s?no|sr\.?|date|time|date\/time|status|location|center|centre|branch|remarks?|activity|particulars?|details?|event|scan)/i;

function parseHistoryTable(tableHtml) {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
  let tr;
  while ((tr = trRe.exec(tableHtml))) {
    const cells = [];
    let hasTh = false;
    const cellRe = /<(t[dh])\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi;
    let c;
    while ((c = cellRe.exec(tr[1]))) {
      if (c[1].toLowerCase() === 'th') hasTh = true;
      cells.push(htmlToText(c[2]));
    }
    if (cells.some(Boolean)) rows.push({ cells, hasTh });
  }
  let headers = null;
  if (rows.length && (rows[0].hasTh || rows[0].cells.every((x) => !x || HISTORY_HEADER_WORDS.test(x)))) {
    headers = rows.shift().cells;
  }
  return { headers, rows: rows.map((r) => r.cells) };
}

function classifyStatus(text) {
  const t = text.toLowerCase();
  if (!t) return 'unknown';
  if (/\bundeliver|not\s+deliver/.test(t)) return 'exception';
  if (/\bdelivered\b/.test(t)) return 'delivered';
  if (/\breturn|\brto\b/.test(t)) return 'returned';
  if (/out\s+for\s+delivery|\bofd\b/.test(t)) return 'out_for_delivery';
  return 'in_progress';
}

/**
 * "For Any Query, Contact To -- 022 - 21023738 -- 98792 04621 -- 9879204621 -- 00000000000"
 *   → ["022-21023738", "98792 04621"]
 * Branches type these by hand: numbers are separated by "--" (sometimes commas or slashes),
 * the same number repeats in different spacing, and all-zero placeholders appear.
 */
function extractPhones(contactText) {
  const body = String(contactText || '').replace(/^[\s\S]*?contact\s*(?:to|no\.?|us)?\s*:?\s*/i, '');
  const seen = new Set();
  const phones = [];
  for (const segment of body.split(/\s*(?:-{2,}|[,;/|])\s*/)) {
    const display = segment.trim().replace(/\s*-\s*/g, '-');
    if (!/^\+?\d[\d -]*\d$/.test(display)) continue;
    const digits = display.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 13 || /^0+$/.test(digits)) continue;
    const key = digits.slice(-10); // "+91 98792 04621", "098792 04621" and "9879204621" are one number
    if (seen.has(key)) continue;
    seen.add(key);
    phones.push(display);
  }
  return phones;
}

/** Frm_DocTrackWeb.aspx → structured record. */
function parseDetail(html) {
  if (innerById(html, 'span', 'lblDocNumber') === null) {
    throw new UpstreamError('The tracking detail page has an unexpected format.', 502, 'UPSTREAM_CHANGED');
  }
  const text = (id) => htmlToText(innerById(html, 'span', id) || '');

  // lblStatus = "<status line><br>For Any Query, Contact To -- 77188 49943 -- …"
  const statusParts = (innerById(html, 'span', 'lblStatus') || '')
    .split(/<br\s*\/?>/i)
    .map(htmlToText)
    .filter(Boolean);
  let statusText = statusParts[0] || '';
  let contactText = statusParts.slice(1).join(' ');
  const queryAt = statusText.search(/for any query/i);
  if (queryAt >= 0) {
    contactText = (statusText.slice(queryAt) + ' ' + contactText).trim();
    statusText = statusText.slice(0, queryAt).trim();
  }
  const phones = extractPhones(contactText);
  const statusDate = (statusText.match(/\bdated\s*:?\s*(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/i) || [])[1] || '';

  const booking = {
    docNo: text('lblDocNumber'),
    fromCenter: text('txtFromCenter'),
    toCenter: text('txtToCenter'),
    bookedAt: text('txtDate'),
    consignee: text('txtReceiver'),
  };
  const history = parseHistoryTable(innerById(html, 'table', 'tblTrack') || '');
  // The site has three outcomes: a booking with a status; nothing at all (unknown number);
  // or a status scan with no booking behind it (no origin, destination or date). The last
  // is real courier data, so it counts as found, but hasBooking lets the page flag it.
  const hasBooking = Boolean(booking.fromCenter || booking.toCenter || booking.bookedAt || booking.consignee);
  const found = hasBooking || Boolean(statusText) || history.rows.length > 0;

  return {
    found,
    hasBooking,
    booking,
    status: { code: classifyStatus(statusText), text: statusText, date: statusDate },
    contact: { text: contactText, phones },
    history,
  };
}

// ───────────────────────────── API ─────────────────────────────
function parseAwbInput(raw) {
  const tokens = String(raw || '')
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const unique = [...new Set(tokens)];
  return { valid: unique.filter((t) => AWB_PATTERN.test(t)), invalid: unique.filter((t) => !AWB_PATTERN.test(t)) };
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

async function trackAwbs(awbs) {
  const startedAt = Date.now();
  const { listUrl, cookie, html } = await submitSearch(awbs);
  const links = new Map();
  for (const link of parseDocList(html, listUrl)) if (!links.has(link.awb)) links.set(link.awb, link);

  const results = await mapLimit(awbs, DETAIL_CONCURRENCY, async (awb) => {
    const link = links.get(awb);
    if (!link) return { awb, found: false, reason: 'not_listed' };
    try {
      const res = await upstreamFetch(link.detailUrl, { cookie, referer: listUrl });
      if (!res.ok) throw new UpstreamError(`Detail page returned HTTP ${res.status}.`);
      return { awb, ...parseDetail(await res.text()), detailUrl: link.detailUrl };
    } catch (err) {
      return { awb, found: false, reason: 'error', error: err.message };
    }
  });

  return {
    ok: true,
    query: awbs,
    officialUrl: listUrl,
    summary: {
      total: results.length,
      found: results.filter((r) => r.found).length,
      notFound: results.filter((r) => !r.found && r.reason !== 'error').length,
      errors: results.filter((r) => r.reason === 'error').length,
    },
    results,
    fetchedAt: new Date().toISOString(),
    tookMs: Date.now() - startedAt,
  };
}


// ───────────────────────────── request handling ─────────────────────────────
/**
 * Validate the raw ?awb= value and run the search.
 * Returns { status, body }: the HTTP status and JSON body for the caller to send.
 * Never throws: upstream failures become 502/504 bodies, anything else a 500.
 */
async function trackRequest(rawAwb) {
  const { valid, invalid } = parseAwbInput(rawAwb);
  const fail = (status, code, message, extra = {}) => ({ status, body: { ok: false, error: { code, message, ...extra } } });
  if (!valid.length && !invalid.length) return fail(400, 'EMPTY', 'Enter at least one AWB number.');
  if (invalid.length) {
    return fail(400, 'INVALID_AWB', `AWB numbers must be exactly 12 digits. Check: ${invalid.join(', ')}`, { invalid });
  }
  if (valid.length > MAX_AWBS) return fail(400, 'TOO_MANY', `Search up to ${MAX_AWBS} AWB numbers at a time.`);
  try {
    return { status: 200, body: await trackAwbs(valid) };
  } catch (err) {
    const known = err instanceof UpstreamError;
    if (!known) console.error(err);
    return fail(known ? err.status : 500, known ? err.code : 'INTERNAL_ERROR', err.message || 'Unexpected error.');
  }
}

module.exports = {
  UPSTREAM,
  MAX_AWBS,
  UpstreamError,
  trackRequest,
  trackAwbs,
  parseDetail,
  parseDocList,
  parseHistoryTable,
  parseAwbInput,
  inputValue,
  classifyStatus,
  extractPhones,
};
