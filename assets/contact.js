/* AWB Tracker: the contact form (contact.html).
   Checks the fields in the browser, then posts the form the way Netlify Forms expects (see README).
   Without JavaScript the browser's own validation and a plain form POST still work. */
(() => {
  'use strict';

  const form = document.getElementById('contact-form');
  if (!form) return;

  const SEND_TIMEOUT_MS = 20000;
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  const formView = document.getElementById('form-view');
  const sentView = document.getElementById('sent-view');
  const sentTitle = document.getElementById('sent-title');
  const againBtn = document.getElementById('again-btn');
  const sendBtn = document.getElementById('send-btn');
  const sendError = document.getElementById('send-error');
  const counter = document.getElementById('f-message-count');
  const honeypot = form.elements['bot-field'];

  // Our messages replace the browser's own validation bubbles.
  form.noValidate = true;

  // ── rules ─────────────────────────────────────────────
  // Each field says how to read its value and returns an error message ('' when the value is fine).
  // Order matches the page, so the first failing field is the first one the user meets.
  // maxlength on the inputs already caps the lengths, so only minimums are checked here.
  const FIELDS = [
    {
      el: document.getElementById('f-name'),
      read: (el) => el.value.trim(),
      check: (v) => !v ? 'Enter your name.' : v.length < 2 ? 'Your name needs at least 2 characters.' : '',
    },
    {
      el: document.getElementById('f-email'),
      read: (el) => el.value.trim(),
      check: (v) => !v ? 'Enter your email address so we can reply.'
        : !EMAIL.test(v) ? 'Enter a valid email address, such as name@example.com.' : '',
    },
    {
      el: document.getElementById('f-topic'),
      read: (el) => el.value,
      check: (v) => v ? '' : 'Choose what your message is about.',
    },
    {
      el: document.getElementById('f-awb'),
      read: (el) => el.value.replace(/\s+/g, ''),   // "1711 0008 7119" is fine
      check: (v) => !v || /^\d{12}$/.test(v) ? '' : 'An AWB number has exactly 12 digits. Leave this blank if it doesn’t apply.',
    },
    {
      el: document.getElementById('f-message'),
      read: (el) => el.value.trim(),
      check: (v) => !v ? 'Write your message.' : v.length < 10 ? 'Add a little more detail, at least 10 characters.' : '',
    },
    {
      el: document.getElementById('f-consent'),
      read: (el) => el.checked,
      check: (v) => v ? '' : 'Tick the box to agree before sending.',
    },
  ];
  const messageEl = FIELDS[4].el;

  // ── showing errors ────────────────────────────────────
  function showError(el, message) {
    const slot = document.getElementById(`${el.id}-error`);   // linked to the field by aria-describedby
    if (message) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
    slot.replaceChildren();
    if (message) {
      const prefix = document.createElement('span');
      prefix.className = 'visually-hidden';
      prefix.textContent = 'Error: ';
      slot.append(prefix, message);
    }
    slot.hidden = !message;
  }

  function validate(field) {
    const message = field.check(field.read(field.el));
    showError(field.el, message);
    return !message;
  }

  // Check a field when the user leaves it, but only once there is something in it (or it was already
  // flagged), so tabbing through the form doesn't shout. Once flagged, re-check as they type or choose,
  // so the message disappears the moment the problem is fixed.
  for (const field of FIELDS) {
    const { el } = field;
    el.addEventListener('blur', () => { if (field.read(el) || el.hasAttribute('aria-invalid')) validate(field); });
    const fixEvent = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(fixEvent, () => { if (el.hasAttribute('aria-invalid')) validate(field); });
  }

  const updateCount = () => { counter.textContent = `${messageEl.value.length} / ${messageEl.maxLength}`; };
  messageEl.addEventListener('input', updateCount);

  // ── sending ───────────────────────────────────────────
  let sending = false;

  function setBusy(busy) {
    sending = busy;
    form.setAttribute('aria-busy', String(busy));
    sendBtn.disabled = busy;
    sendBtn.innerHTML = busy ? '<span class="spinner" aria-hidden="true"></span>Sending…' : 'Send message';
  }

  function showSent() {
    form.reset();
    updateCount();
    FIELDS.forEach((f) => showError(f.el, ''));
    sendError.hidden = true;
    formView.hidden = true;
    sentView.hidden = false;
    sentTitle.focus();   // moves screen-reader users to the confirmation
  }

  async function send() {
    setBusy(true);
    sendError.hidden = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      // Netlify Forms takes a urlencoded POST that names the form (the hidden "form-name" field).
      const res = await fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)).toString(),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showSent();
    } catch {
      sendError.hidden = false;   // role="alert" announces it; what the user typed is kept
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (sending) return;

    let firstBad = null;
    for (const field of FIELDS) {
      if (!validate(field) && !firstBad) firstBad = field.el;
    }
    if (firstBad) { firstBad.focus(); return; }

    // Send the tidied values: trimmed text, and the AWB number without spaces (the checkbox keeps its "yes").
    for (const field of FIELDS) if (field.el.type !== 'checkbox') field.el.value = field.read(field.el);

    // Bots fill in every field, including the one people can't see. Look successful, send nothing.
    if (honeypot && honeypot.value) { showSent(); return; }

    send();
  });

  againBtn.addEventListener('click', () => {
    sentView.hidden = true;
    formView.hidden = false;
    FIELDS[0].el.focus();
  });
})();
