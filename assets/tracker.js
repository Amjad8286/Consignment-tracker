/* AWB Tracker: the tracker page (index.html). Talks to the relay at /api/track (server.js or the Netlify Function). */
(() => {
  'use strict';

  // Relay address from <meta name="awb-relay">: "" when server.js served this page (same origin),
  // otherwise e.g. http://localhost:3000 for file://, Live Server (:5500) or any other static host.
  const RELAY_META = document.querySelector('meta[name="awb-relay"]');
  const API_BASE = (RELAY_META ? RELAY_META.content : 'http://localhost:3000').trim().replace(/\/+$/, '');
  const RELAY_LABEL = API_BASE || location.origin;
  const CLIENT_TIMEOUT_MS = 60000;
  const MAX_AWBS = 25;
  const RECENT_KEY = 'awbTracker.recent';

  const form = document.getElementById('search-form');
  const input = document.getElementById('awb-input');
  const button = document.getElementById('track-btn');
  const msg = document.getElementById('awb-msg');
  const resultsEl = document.getElementById('results');
  const recentEl = document.getElementById('recent');
  const DEFAULT_HINT = msg.textContent;

  let inflight = null;
  let lastQuery = [];

  // ── helpers ───────────────────────────────────────────
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  /** "16-11-26 - 08:10 PM" → "16 Nov 2026, 08:10 PM"; anything unexpected is returned as-is. */
  function formatDate(raw) {
    const m = String(raw || '').trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s*-?\s*(.+))?$/);
    if (!m) return String(raw || '').trim();
    const month = MONTHS[Number(m[2]) - 1];
    if (!month) return raw;
    const year = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${Number(m[1])} ${month} ${year}${m[4] ? ', ' + m[4].trim() : ''}`;
  }

  function parseInput(raw) {
    const tokens = String(raw).split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
    const unique = [...new Set(tokens)];
    return { valid: unique.filter((t) => /^\d{12}$/.test(t)), invalid: unique.filter((t) => !/^\d{12}$/.test(t)) };
  }

  function validate(raw, { strict }) {
    const { valid, invalid } = parseInput(raw);
    if (!valid.length && !invalid.length) {
      return strict ? { ok: false, message: 'Enter an AWB number to track.' } : { ok: true, message: DEFAULT_HINT, neutral: true };
    }
    if (invalid.length) {
      const sample = invalid.slice(0, 3).map((t) => `“${t}”`).join(', ') + (invalid.length > 3 ? ` and ${invalid.length - 3} more` : '');
      return { ok: false, message: `AWB numbers have exactly 12 digits. Check ${sample}.` };
    }
    if (valid.length > MAX_AWBS) return { ok: false, message: `Track up to ${MAX_AWBS} numbers at a time. You entered ${valid.length}.` };
    return { ok: true, valid, message: valid.length === 1 ? 'Ready to track 1 number.' : `Ready to track ${valid.length} numbers.` };
  }

  function showFieldMessage(result) {
    msg.textContent = result.message;
    msg.classList.toggle('is-error', !result.ok);
    input.setAttribute('aria-invalid', String(!result.ok));
  }

  // ── recent searches (per browser, best effort) ─────────
  function loadRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((x) => typeof x === 'string'); }
    catch { return []; }
  }
  function saveRecent(query) {
    try {
      const key = query.join(', ');
      const list = [key, ...loadRecent().filter((x) => x !== key)].slice(0, 6);
      localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch { /* storage unavailable — ignore */ }
    renderRecent();
  }
  function renderRecent() {
    const list = loadRecent();
    recentEl.hidden = list.length === 0;
    recentEl.innerHTML = list.length
      ? '<span>Recent:</span>' + list.map((q) => `<button type="button" class="chip" data-q="${esc(q)}">${esc(q.length > 32 ? q.slice(0, 30) + '…' : q)}</button>`).join('')
      : '';
  }

  // ── URL sync so results can be bookmarked / reloaded ───
  function setUrl(query, push) {
    try {
      const url = new URL(location.href);
      if (query.length) url.searchParams.set('awb', query.join(',')); else url.searchParams.delete('awb');
      history[push ? 'pushState' : 'replaceState']({ awb: query }, '', url);
    } catch { /* file:// in some browsers — ignore */ }
  }

  // ── rendering ─────────────────────────────────────────
  const STATUS_LABEL = {
    delivered: 'Delivered',
    out_for_delivery: 'Out for delivery',
    in_progress: 'In transit',
    returned: 'Returned',
    exception: 'Delivery issue',
    unknown: 'Status not updated',
  };
  const ICON = {
    delivered: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>',
    returned: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4L2.5 7.5 6 11"/><path d="M3 7.5h7a3.5 3.5 0 0 1 0 7H8"/></svg>',
    exception: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M8 3.5v5.5"/><path d="M8 12.5v.01"/></svg>',
    default: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h9"/><path d="M9 4.5L12.5 8 9 11.5"/></svg>',
  };

  const groupAwb = (awb) => {
    const s = String(awb);
    return /^\d{12}$/.test(s)
      ? [s.slice(0, 4), s.slice(4, 8), s.slice(8)].map((g) => `<span class="grp">${g}</span>`).join('')
      : esc(s);
  };

  function stubHtml(r, badge) {
    const official = r.detailUrl
      ? `<a class="btn btn-quiet" href="${esc(r.detailUrl)}" target="_blank" rel="noopener noreferrer">Open on courier site</a>`
      : '';
    return `
      <div class="stub">
        <div>
          <span class="awb-caption">AWB number</span>
          <h2 class="awb" aria-label="AWB ${esc(r.awb)}">${groupAwb(r.awb)}</h2>
        </div>
        <span class="badge">${esc(badge)}</span>
        <div class="stub-actions">
          <button type="button" class="btn btn-quiet" data-copy="${esc(r.awb)}">Copy number</button>
          ${official}
        </div>
      </div>`;
  }

  function slipHtml(r) {
    if (r.reason === 'error') {
      return `<article class="slip s-error">${stubHtml(r, 'Couldn’t load')}
        <p class="slip-note">The courier website didn’t return details for this number (${esc(String(r.error || 'unknown error').replace(/\.+$/, ''))}). Use <strong>Refresh</strong> to try again.</p></article>`;
    }
    if (!r.found) {
      return `<article class="slip s-notfound">${stubHtml(r, 'Not found')}
        <p class="slip-note">There is no booking for this AWB number on the courier’s tracking. Check the number against the booking receipt and try again.</p></article>`;
    }

    const code = STATUS_LABEL[r.status.code] ? r.status.code : 'unknown';
    const b = r.booking;
    const delivered = code === 'delivered';
    const toLine = delivered && r.status.date ? `Delivered ${esc(formatDate(r.status.date))}` : 'Destination';
    const icon = ICON[code] || ICON.default;

    const phones = (r.contact && r.contact.phones) || [];
    const helpDesk = phones.length
      ? phones.map((p) => `<a href="tel:${esc(p.replace(/[^\d+]/g, ''))}">${esc(p)}</a>`).join('<span class="sep">/</span>')
      : (r.contact && r.contact.text ? esc(r.contact.text) : '');

    const facts = [
      ['Consignee', b.consignee],
    ].filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')
      + (helpDesk ? `<dt>Help desk</dt><dd>${helpDesk}</dd>` : '');

    const h = r.history || { rows: [] };
    const history = h.rows && h.rows.length ? `
      <div class="history">
        <h4>Tracking history</h4>
        <div class="history-scroll"><table>
          ${h.headers ? `<thead><tr>${h.headers.map((x) => `<th scope="col">${esc(x)}</th>`).join('')}</tr></thead>` : ''}
          <tbody>${h.rows.map((row) => `<tr>${row.map((c) => `<td>${esc(c).replace(/\n/g, '<br>')}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></div>
      </div>` : '';

    // The courier has a scan for this number but no booking behind it: show what it reports,
    // without a route strip whose ends would be blank.
    if (r.hasBooking === false) {
      return `
      <article class="slip s-${code}">
        ${stubHtml(r, STATUS_LABEL[code])}
        ${r.status.text ? `<p class="status-line">${esc(r.status.text)}</p>` : ''}
        <p class="slip-note"><strong>No booking details on record.</strong> The courier’s tracking shows the update above for this number, but no origin, destination or booking date. If you expected a booking, check the number against your receipt.</p>
        ${facts ? `<dl class="facts">${facts}</dl>` : ''}
        ${history}
      </article>`;
    }

    return `
      <article class="slip s-${code}">
        ${stubHtml(r, STATUS_LABEL[code])}
        <div class="route">
          <div class="track" role="img" aria-label="From ${esc(b.fromCenter || 'origin')} to ${esc(b.toCenter || 'destination')}: ${esc(STATUS_LABEL[code])}">
            <span class="done"></span>
            <span class="end from"></span>
            <span class="end to"></span>
            ${code === 'unknown' ? '' : `<span class="marker">${icon}</span>`}
          </div>
          <div class="places">
            <div class="place from"><h3>${esc(b.fromCenter || '—')}</h3><p>${b.bookedAt ? 'Booked ' + esc(formatDate(b.bookedAt)) : 'Origin'}</p></div>
            <div class="place to"><h3>${esc(b.toCenter || '—')}</h3><p>${toLine}</p></div>
          </div>
        </div>
        ${r.status.text ? `<p class="status-line">${esc(r.status.text)}</p>` : ''}
        ${facts ? `<dl class="facts">${facts}</dl>` : ''}
        ${history}
      </article>`;
  }

  function summaryHtml(data) {
    const counts = {};
    for (const r of data.results) {
      const k = r.reason === 'error' ? 'couldn’t load'
        : !r.found ? 'not found'
        : r.hasBooking === false ? 'without booking details'
        : (STATUS_LABEL[r.status.code] || 'other').toLowerCase();
      counts[k] = (counts[k] || 0) + 1;
    }
    const parts = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
    const time = new Date(data.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const head = data.results.length === 1 ? `Updated ${time}` : `${plural(data.results.length, 'number', 'numbers')}: ${parts}. Updated ${time}.`;
    return `
      <div class="summary">
        <p>${esc(head)}</p>
        <div class="summary-actions">
          <button type="button" class="btn btn-outline" data-action="refresh">Refresh</button>
          ${data.results.length > 1 && data.officialUrl ? `<a class="btn btn-outline" href="${esc(data.officialUrl)}" target="_blank" rel="noopener noreferrer">Open all on courier site</a>` : ''}
        </div>
      </div>`;
  }

  function renderResults(data) {
    resultsEl.innerHTML = summaryHtml(data) + data.results.map(slipHtml).join('');
  }

  function renderLoading(count) {
    const one = `
      <div class="slip skeleton" aria-hidden="true">
        <div class="stub"><div class="sk-id"><div class="bar sk-caption"></div><div class="bar sk-awb"></div></div></div>
        <div class="bar sk-route"></div>
        <div class="sk-places"><div class="bar sk-from"></div><div class="bar sk-to"></div></div>
        <div class="bar sk-status"></div>
      </div>`;
    resultsEl.innerHTML = `<p class="visually-hidden">Tracking ${plural(count, 'AWB number', 'AWB numbers')}…</p>` + one.repeat(Math.min(count, 3));
  }

  function renderEmpty() {
    resultsEl.innerHTML = `
      <div class="panel">
        <h2>Enter an AWB number to see its status</h2>
        <p>The AWB number is the 12-digit number printed on the booking receipt, for example <span class="empty-sample">171100087119</span>. To track several at once, separate them with commas.</p>
      </div>`;
  }

  function renderError(title, body, retry = true) {
    resultsEl.innerHTML = `
      <div class="panel is-error" role="alert">
        <h2>${esc(title)}</h2>
        <p>${body}</p>
        ${retry ? '<p><button type="button" class="btn btn-outline" data-action="refresh">Try again</button></p>' : ''}
      </div>`;
  }

  function setBusy(busy) {
    resultsEl.setAttribute('aria-busy', String(busy));
    button.disabled = busy;
    button.innerHTML = busy ? '<span class="spinner" aria-hidden="true"></span>Tracking…' : 'Track';
  }

  // ── API call ──────────────────────────────────────────
  async function track(query, { push = true } = {}) {
    if (inflight) inflight.abort();
    const controller = new AbortController();
    inflight = controller;
    const timer = setTimeout(() => controller.abort('timeout'), CLIENT_TIMEOUT_MS);

    lastQuery = query;
    setUrl(query, push);
    setBusy(true);
    renderLoading(query.length);

    try {
      const res = await fetch(`${API_BASE}/api/track?awb=${encodeURIComponent(query.join(','))}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      let data = null;
      try { data = await res.json(); } catch { /* non-JSON */ }

      if (!data) {
        // Something other than the relay answered (e.g. a static server's 404 page).
        renderError(
          'The tracking relay didn’t answer',
          `<code>${esc(RELAY_LABEL)}/api/track</code> returned HTTP ${res.status} without tracking data, so it isn’t the relay. Start it with <code>node server.js</code> in the project folder. If it runs on another port, set that address in the <code>awb-relay</code> meta tag at the top of <code>index.html</code>.`
        );
        return;
      }
      if (!res.ok || !data.ok) {
        const message = (data.error && data.error.message) || `The relay answered with HTTP ${res.status}.`;
        const code = data.error && data.error.code;
        if (code === 'INVALID_AWB' || code === 'TOO_MANY' || code === 'EMPTY') {
          showFieldMessage({ ok: false, message });
          resultsEl.innerHTML = '';
          return;
        }
        const title = res.status === 504 ? 'The courier website is slow to respond' : 'Tracking is unavailable right now';
        renderError(title, esc(message));
        return;
      }

      saveRecent(query);
      renderResults(data);
    } catch (err) {
      if (controller.signal.aborted && controller.signal.reason !== 'timeout') return; // replaced by a newer search
      if (controller.signal.reason === 'timeout') {
        renderError('The search took too long', 'The courier website didn’t answer within a minute. Try again in a moment.');
      } else {
        renderError(
          'The local relay isn’t running',
          `This page gets its data through <code>server.js</code> on this computer, expected at <code>${esc(RELAY_LABEL)}</code>. Start it with <code>node server.js</code> in the project folder, then press <strong>Try again</strong>. If it runs on another port, set that address in the <code>awb-relay</code> meta tag at the top of <code>index.html</code>.`
        );
      }
    } finally {
      clearTimeout(timer);
      if (inflight === controller) { inflight = null; setBusy(false); }
    }
  }

  // ── events ────────────────────────────────────────────
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const result = validate(input.value, { strict: true });
    showFieldMessage(result);
    if (!result.ok) { input.focus(); return; }
    input.value = result.valid.join(', ');
    track(result.valid);
  });

  input.addEventListener('input', () => {
    const result = validate(input.value, { strict: false });
    // Don't nag mid-typing: only flag errors once a separator or 12+ characters are present.
    const settled = /[\s,;]/.test(input.value) || input.value.replace(/\s/g, '').length >= 12;
    showFieldMessage(result.ok || settled ? result : { ok: true, message: DEFAULT_HINT });
  });

  // Text inputs drop line breaks on paste, which would glue numbers together.
  input.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData('text');
    if (!text || !/[\r\n\t]/.test(text)) return;
    e.preventDefault();
    const cleaned = text.split(/[\r\n\t]+/).map((s) => s.trim()).filter(Boolean).join(', ');
    const { selectionStart: s, selectionEnd: en, value } = input;
    input.value = value.slice(0, s) + cleaned + value.slice(en);
    input.dispatchEvent(new Event('input'));
  });

  recentEl.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-q]');
    if (!chip) return;
    input.value = chip.dataset.q;
    form.requestSubmit();
  });

  resultsEl.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      const value = copyBtn.dataset.copy;
      try {
        // writeText can stay pending while a permission prompt is open, so cap the wait.
        await Promise.race([
          navigator.clipboard.writeText(value),
          new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard timeout')), 1000)),
        ]);
      } catch {
        const ta = Object.assign(document.createElement('textarea'), { value });
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } finally { ta.remove(); }
      }
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy number'; }, 1500);
      return;
    }
    if (e.target.closest('[data-action="refresh"]') && lastQuery.length) track(lastQuery, { push: false });
  });

  // Clicking an in-page link (header nav, "Back to top") also fires popstate. Only react when the
  // ?awb= query actually differs from what is on screen, so those links never re-run or clear a search.
  window.addEventListener('popstate', () => {
    let q = '';
    try { q = new URL(location.href).searchParams.get('awb') || ''; } catch {}
    const { valid, invalid } = parseInput(q);
    const wanted = invalid.length || valid.length > MAX_AWBS ? [] : valid;
    if (wanted.join(',') === lastQuery.join(',')) return;
    startFromUrl(false);
  });

  function startFromUrl(push) {
    let q = '';
    try { q = new URL(location.href).searchParams.get('awb') || ''; } catch {}
    const result = validate(q, { strict: false });
    if (q && result.ok && result.valid) {
      input.value = result.valid.join(', ');
      showFieldMessage(result);
      track(result.valid, { push });
    } else {
      renderEmpty();
    }
  }

  renderRecent();
  startFromUrl(false);
})();
