/* AWB Tracker: behaviour shared by every page. */
(() => {
  'use strict';

  // The footer carries a fallback year in the HTML; this keeps it current.
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();
})();
