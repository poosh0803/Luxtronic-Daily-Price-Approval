let data = null; // { query, results, warnings }
let preset = 'main';

const MAIN_SHOPS = /centre ?com|mwave|scorptec|pc ?case ?gear/i;

function showAlert(message, type = 'danger') {
  document.getElementById('alertBox').innerHTML = message
    ? `<div class="alert alert-${type}">${escapeHtml(message)}</div>`
    : '';
}

function visibleRows() {
  const hideNoise = document.getElementById('hideNoise').checked;
  const hideOos = document.getElementById('hideOos').checked;
  return data.results.filter((r) =>
    (preset === 'all' || MAIN_SHOPS.test(r.store))
    && !(hideNoise && r.noise)
    && !(hideOos && r.inStock === false));
}

function stockBadge(r) {
  const tick = r.verified ? ' <i class="fas fa-circle-check verified-tick" title="Read from the shop\'s own site"></i>' : '';
  if (r.inStock === true) return `<span class="badge badge-ok">${escapeHtml(r.availability === 'Unknown' ? 'In stock' : r.availability)}</span>${tick}`;
  if (r.inStock === false) return `<span class="badge badge-danger">${escapeHtml(r.availability)}</span>${tick}`;
  return `<span class="badge badge-grey">Not shown</span>${tick}`;
}

function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function renderStats(rows) {
  const prices = rows.map((r) => r.price).sort((a, b) => a - b);
  const set = (id, text) => { document.getElementById(id).textContent = text; };
  set('statCount', rows.length);
  set('statOf', `of ${data.results.length} found`);
  set('statLow', prices.length ? formatMoney(prices[0]) : '-');
  set('statLowStore', rows.length ? rows[0].store : '');
  set('statMid', prices.length ? formatMoney(median(prices)) : '-');
  set('statHigh', prices.length ? formatMoney(prices[prices.length - 1]) : '-');
}

function rowHtml(r) {
  const href = safeUrl(r.url);
  const name = href
    ? `<a href="${href}" target="_blank" rel="noopener">${escapeHtml(r.name)}</a>`
    : escapeHtml(r.name);
  const was = r.wasPrice ? `<div class="was-price">${formatMoney(r.wasPrice)}</div>` : '';
  return `
    <tr>
      <td><div class="product-name" style="min-width:120px;">${escapeHtml(r.store)}</div>${r.location ? `<div class="product-meta">${escapeHtml(r.location)}</div>` : ''}</td>
      <td>${name}${r.noise ? ' <span class="badge badge-warn">Check</span>' : ''}</td>
      <td class="num"><strong>${formatMoney(r.price)}</strong>${was}</td>
      <td>${stockBadge(r)}</td>
      <td>${escapeHtml(r.updated || '-')}</td>
    </tr>`;
}

function render() {
  if (!data) return;
  const rows = visibleRows();
  document.getElementById('resultBody').innerHTML = rows.map(rowHtml).join('');
  document.getElementById('emptyState').style.display = rows.length ? 'none' : 'block';
  renderStats(rows);
}

async function search(query) {
  const btn = document.getElementById('searchBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Searching';
  showAlert('');
  try {
    const pages = document.getElementById('pages').value;
    data = await fetchJSON(`/api/lookup?q=${encodeURIComponent(query)}&pages=${pages}`);
    document.getElementById('results').style.display = 'block';
    history.replaceState(null, '', `/lookup?q=${encodeURIComponent(query)}`);
    render();
    if (data.warnings.length) showAlert(`Partial results: ${data.warnings.join('; ')}`, 'info');
    if (!data.results.length) showAlert('No results for that search.', 'info');
  } catch (error) {
    document.getElementById('results').style.display = 'none';
    showAlert(error.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-magnifying-glass"></i> Search';
  }
}

function exportCsv() {
  const rows = visibleRows();
  if (!rows.length) return;
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Shop', 'Location', 'Product', 'Price', 'Was price', 'Stock', 'Updated', 'URL'].map(cell).join(',')];
  rows.forEach((r) => lines.push([r.store, r.location, r.name, r.price, r.wasPrice, r.inStock === null ? 'Not shown' : r.availability, r.updated, r.url].map(cell).join(',')));
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' }));
  link.download = `prices-${data.query.replace(/[^a-z0-9]+/gi, '-')}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

document.getElementById('searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = document.getElementById('query').value.trim();
  if (q) search(q);
});
document.getElementById('storePreset').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-preset]');
  if (!btn) return;
  preset = btn.dataset.preset;
  document.querySelectorAll('#storePreset .tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
  render();
});
document.getElementById('hideNoise').addEventListener('change', render);
document.getElementById('hideOos').addEventListener('change', render);
document.getElementById('csvBtn').addEventListener('click', exportCsv);

const initial = new URLSearchParams(location.search).get('q');
if (initial) {
  document.getElementById('query').value = initial;
  search(initial);
}
