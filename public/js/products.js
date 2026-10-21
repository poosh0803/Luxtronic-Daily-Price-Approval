let products = [];

function showAlert(message, type = 'danger') {
  document.getElementById('alertBox').innerHTML = message
    ? `<div class="alert alert-${type}">${escapeHtml(message)}</div>`
    : '';
}

// A product the latest run looked at but could not price shows that instead of plain "Tracked".
function statusBadge(p) {
  if (p.has_pending) return '<span class="badge badge-warn">Awaiting approval</span>';
  if (!p.tracked) return '<span class="badge badge-grey">Not tracked</span>';
  if (p.no_listing_until && new Date(p.no_listing_until) > new Date()) {
    const until = new Date(p.no_listing_until).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const title = escapeHtml(`${p.no_listing_note || 'The shops do not list this'} (skipped until ${until})`);
    return `<span class="badge badge-grey" title="${title}">No listing</span> <button class="btn btn-sm" data-retry="${p.id}" title="Include it in the next run again">Retry</button>`;
  }
  // Only products with stock are priced, so an old "couldn't price" on a now-empty product means nothing.
  if (Number(p.qty_available) > 0 && (p.last_outcome === 'skipped' || p.last_outcome === 'failed')) {
    const why = escapeHtml(p.last_reason || '');
    return `<span class="badge badge-danger" title="${why}">Couldn't price</span> <button class="btn btn-sm" data-nolisting="${p.id}" title="The shops don't carry it: skip it for 30 days">No listing</button>`;
  }
  return '<span class="badge badge-ok">Tracked</span>';
}

function render() {
  const q = document.getElementById('search').value.trim().toLowerCase();
  const hideZero = document.getElementById('hideZero').checked;
  const rows = products.filter((p) => (!q || `${p.name} ${p.sku || ''}`.toLowerCase().includes(q)) && !(hideZero && Number(p.qty_available) <= 0));
  document.getElementById('productBody').innerHTML = rows
    .map((p) => `
      <tr>
        <td><input type="checkbox" data-track="${p.id}" ${p.tracked ? 'checked' : ''}></td>
        <td><div class="product-name"><a href="/lookup?q=${encodeURIComponent(p.name)}" title="Look up market prices">${escapeHtml(p.name)}</a></div><div class="product-meta">${escapeHtml(p.sku || '')}</div></td>
        <td>${escapeHtml(p.category)}</td>
        <td><input type="text" class="hint-input" data-hint="${p.id}" value="${escapeHtml(p.search_hint || '')}" placeholder="auto" maxlength="120" title="Words the pricing run searches for first. Leave empty to use the automatic ones."></td>
        <td class="num">${formatMoney(p.current_price)}</td>
        <td class="num">${Number(p.qty_available)}</td>
        <td>${statusBadge(p)}</td>
      </tr>`)
    .join('');
  document.getElementById('emptyState').style.display = rows.length ? 'none' : 'block';
}

async function load() {
  try {
    products = (await fetchJSON('/api/products')).products;
    render();
  } catch (error) {
    showAlert(error.message);
  }
}

document.getElementById('search').addEventListener('input', render);
document.getElementById('hideZero').addEventListener('change', () => {
  try { localStorage.setItem('hideZeroStock', document.getElementById('hideZero').checked ? '1' : '0'); } catch { /* storage unavailable */ }
  render();
});
try { document.getElementById('hideZero').checked = localStorage.getItem('hideZeroStock') === '1'; } catch { /* storage unavailable */ }

document.addEventListener('change', async (e) => {
  const hint = e.target.closest('[data-hint]');
  if (hint) {
    try {
      const { product } = await fetchJSON(`/api/products/${hint.dataset.hint}/search-hint`, { method: 'PUT', body: JSON.stringify({ query: hint.value }) });
      const p = products.find((x) => x.id === Number(hint.dataset.hint));
      if (p) p.search_hint = product.search_hint;
      hint.value = product.search_hint || '';
      showAlert('');
    } catch (error) {
      showAlert(error.message);
    }
    return;
  }
  const box = e.target.closest('[data-track]');
  if (!box) return;
  try {
    await fetchJSON(`/api/products/${box.dataset.track}/tracked`, { method: 'PUT', body: JSON.stringify({ tracked: box.checked }) });
    const p = products.find((x) => x.id === Number(box.dataset.track));
    if (p) p.tracked = box.checked;
    render();
  } catch (error) {
    box.checked = !box.checked;
    showAlert(error.message);
  }
});

// "No listing" / "Retry" buttons in the status column.
document.addEventListener('click', async (e) => {
  const mark = e.target.closest('[data-nolisting]');
  const retry = e.target.closest('[data-retry]');
  const btn = mark || retry;
  if (!btn) return;
  btn.disabled = true;
  try {
    await fetchJSON(`/api/products/${btn.dataset.nolisting || btn.dataset.retry}/no-listing`, {
      method: 'PUT',
      body: JSON.stringify(mark ? { days: 30, note: 'Marked by hand: the shops do not list it' } : { clear: true }),
    });
    await load();
  } catch (error) {
    showAlert(error.message);
    btn.disabled = false;
  }
});

document.getElementById('syncBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  showAlert('');
  try {
    const r = await fetchJSON('/api/products/sync', { method: 'POST' });
    await load();
    showAlert(`Synced ${r.matched} PC parts out of ${r.fetched} Odoo products.`, 'ok');
  } catch (error) {
    showAlert(error.message);
  } finally {
    btn.disabled = false;
  }
});

load();
