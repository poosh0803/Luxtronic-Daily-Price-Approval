// Shared helpers used across pages.

async function fetchJSON(url, options) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options && options.headers) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(data.message || `Request failed (${res.status})`);
  }
  return data;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMoney(amount) {
  return Number(amount).toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });
}

function formatDateTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Only allow http(s) links from retailer data into href attributes.
function safeUrl(url) {
  return /^https?:\/\//i.test(url || '') ? escapeHtml(url) : '';
}

function highlightNav() {
  const path = window.location.pathname;
  document.querySelectorAll('.nav-bar a.nav-item[href]').forEach((a) => {
    if (a.getAttribute('href') === path) a.classList.add('active');
  });
}

function initDarkMode() {
  const toggle = document.getElementById('darkModeToggle');
  const icon = document.getElementById('themeIcon');
  const applyTheme = (dark) => {
    document.body.classList.toggle('dark-mode', dark);
    if (icon) {
      icon.classList.toggle('fa-moon', !dark);
      icon.classList.toggle('fa-sun', dark);
    }
  };
  applyTheme(localStorage.getItem('theme') === 'dark');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const dark = !document.body.classList.contains('dark-mode');
      localStorage.setItem('theme', dark ? 'dark' : 'light');
      applyTheme(dark);
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  highlightNav();
  initDarkMode();
});
