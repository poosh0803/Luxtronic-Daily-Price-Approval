let proposals = [];
let markups = [0, 5, 10, 15];
let activeGroup = 'All';
let categories = [];
const chosen = new Map(); // proposal id -> chosen markup number, or 'custom' (survives re-renders)
const customValues = new Map(); // proposal id -> text typed in the custom box

const SUSPICIOUS_CHANGE = 0.2; // flag market moves bigger than 20% from the current price

function showAlert(message, type = 'danger') {
  document.getElementById('alertBox').innerHTML = message
    ? `<div class="alert alert-${type}">${escapeHtml(message)}</div>`
    : '';
}

function isCustom(p) {
  return chosen.get(p.id) === 'custom';
}

// The markup in dollars, or null while a custom box is selected but empty/invalid.
function markupOf(p) {
  if (isCustom(p)) {
    const v = parseFloat(customValues.get(p.id));
    return Number.isFinite(v) ? v : null;
  }
  return chosen.has(p.id) ? chosen.get(p.id) : markups[0];
}

function diffBadgeHtml(p) {
  const markup = markupOf(p);
  if (markup === null) return '<span class="badge badge-grey">Enter an amount</span>';
  const diff = Number(p.market_price) + markup - Number(p.current_price);
  if (Math.abs(diff) < 0.005) return '<span class="badge badge-grey">No change</span>';
  return `<span class="badge ${diff < 0 ? 'badge-ok' : 'badge-info'}">${diff > 0 ? '+' : '-'}${formatMoney(Math.abs(diff))} vs current</span>`;
}

function customPriceText(p) {
  const markup = markupOf(p);
  return markup === null ? '' : formatMoney(Number(p.market_price) + markup);
}

function retailersHtml(p) {
  const prices = p.retailer_prices;
  const lowest = Math.min(...prices.filter((r) => r.inStock).map((r) => r.price));
  return prices
    .slice()
    .sort((a, b) => a.price - b.price)
    .map((r) => {
      const cls = !r.inStock ? 'oos' : r.price === lowest ? 'lowest' : '';
      const href = safeUrl(r.url);
      const name = href
        ? `<a href="${href}" target="_blank" rel="noopener">${escapeHtml(r.retailer)}</a>`
        : escapeHtml(r.retailer);
      return `<div class="${cls}"><span>${name}${r.inStock ? '' : ' (out)'}</span><span>${formatMoney(r.price)}</span></div>`;
    })
    .join('');
}

function warningBadge(p) {
  const current = Number(p.current_price);
  const market = Number(p.market_price);
  if (current > 0 && Math.abs(market - current) / current > SUSPICIOUS_CHANGE) {
    return '<div style="margin-top:6px;"><span class="badge badge-warn">Big change - check</span></div>';
  }
  return '';
}

function rowHtml(p) {
  const selected = markupOf(p);
  const current = Number(p.current_price);
  const market = Number(p.market_price);
  const chips = markups
    .map((m) => `
      <button type="button" class="markup-chip ${m === selected ? 'selected' : ''}" data-id="${p.id}" data-markup="${m}">
        <strong>+${m}</strong><span>${formatMoney(market + m)}</span>
      </button>`)
    .join('');
  const customChip = `
      <div class="markup-chip markup-custom ${isCustom(p) ? 'selected' : ''}" data-id="${p.id}" data-markup="custom">
        <strong>Custom</strong>
        <input type="number" step="0.01" placeholder="+$" data-custom="${p.id}" value="${escapeHtml(customValues.get(p.id) || '')}">
        <span id="cp-${p.id}">${customPriceText(p)}</span>
      </div>`;

  return `
    <tr data-row="${p.id}">
      <td>
        <div class="product-name">${escapeHtml(p.name)}</div>
        <div class="product-meta">${escapeHtml(p.sku || '')} ${p.sku ? '&middot;' : ''} ${escapeHtml(p.category)}</div>
        ${p.notes ? `<div class="product-meta">${escapeHtml(p.notes)}</div>` : ''}
      </td>
      <td class="num"><strong>${formatMoney(current)}</strong></td>
      <td class="retailers">${retailersHtml(p)}</td>
      <td class="num"><div class="market">${formatMoney(market)}</div>${warningBadge(p)}</td>
      <td><div class="markup-chips">${chips}${customChip}</div><div style="margin-top:6px;" id="diff-${p.id}">${diffBadgeHtml(p)}</div></td>
      <td>
        <div class="row-actions">
          <button class="btn btn-primary btn-sm" data-approve="${p.id}"><i class="fas fa-check"></i> Approve</button>
          <button class="btn btn-sm" data-reject="${p.id}" title="Reject"><i class="fas fa-xmark"></i></button>
        </div>
      </td>
    </tr>`;
}

// Direction compares the market price with the current Odoo price.
const DIRECTIONS = [['all', 'All'], ['drop', 'Drop'], ['rise', 'Rise']];
let activeDir = 'all';

function direction(p) {
  const diff = Number(p.market_price) - Number(p.current_price);
  return diff < 0 ? 'drop' : diff > 0 ? 'rise' : 'same';
}

function matchesSearch(p) {
  const q = document.getElementById('search').value.trim().toLowerCase();
  return !q || `${p.name} ${p.sku || ''}`.toLowerCase().includes(q);
}

function visible() {
  return proposals.filter((p) =>
    (activeGroup === 'All' || p.category_group === activeGroup)
    && (activeDir === 'all' || direction(p) === activeDir)
    && matchesSearch(p));
}

function renderDirTabs() {
  const inGroup = proposals.filter((p) => activeGroup === 'All' || p.category_group === activeGroup);
  document.getElementById('dirTabs').innerHTML = DIRECTIONS
    .map(([key, label]) => {
      const n = key === 'all' ? inGroup.length : inGroup.filter((p) => direction(p) === key).length;
      return `<button class="tab-btn ${key === activeDir ? 'active' : ''}" data-dir="${key}">${label} (${n})</button>`;
    })
    .join('');
}

function renderTabs() {
  // Configured categories always get a tab (even at 0), plus any other group that has proposals.
  const extra = proposals.map((p) => p.category_group).filter((g) => !categories.includes(g));
  const groups = ['All', ...new Set([...categories, ...extra])];
  if (!groups.includes(activeGroup)) activeGroup = 'All';
  const tabs = document.getElementById('groupTabs');
  tabs.innerHTML = groups
    .map((g) => {
      const n = g === 'All' ? proposals.length : proposals.filter((p) => p.category_group === g).length;
      return `<button class="tab-btn ${g === activeGroup ? 'active' : ''}" data-group="${escapeHtml(g)}">${escapeHtml(g)} (${n})</button>`;
    })
    .join('');
}

function renderStats() {
  document.getElementById('statPending').textContent = proposals.length;
  document.getElementById('statDown').textContent = proposals.filter((p) => Number(p.market_price) < Number(p.current_price)).length;
  document.getElementById('statUp').textContent = proposals.filter((p) => Number(p.market_price) > Number(p.current_price)).length;
  const latest = proposals.reduce((max, p) => (new Date(p.created_at) > max ? new Date(p.created_at) : max), new Date(0));
  document.getElementById('statLast').textContent = proposals.length ? formatDateTime(latest) : '-';
}

function render() {
  const rows = visible();
  document.getElementById('proposalBody').innerHTML = rows.map(rowHtml).join('');
  document.getElementById('emptyState').style.display = rows.length ? 'none' : 'block';
  document.getElementById('approveAllBtn').disabled = rows.length === 0;
  document.getElementById('rejectAllBtn').disabled = rows.length === 0;
  renderTabs();
  renderDirTabs();
  renderStats();
}

async function approve(id, button) {
  const p = proposals.find((x) => x.id === id);
  if (!p) return true;
  const markup = markupOf(p);
  if (markup === null) {
    showAlert(`${p.name}: enter a custom markup amount first.`);
    return false;
  }
  if (button) button.disabled = true;
  try {
    await fetchJSON(`/api/proposals/${id}/approve`, { method: 'POST', body: JSON.stringify({ markup, custom: isCustom(p) }) });
    proposals = proposals.filter((x) => x.id !== id);
    chosen.delete(id);
    customValues.delete(id);
    return true;
  } catch (error) {
    showAlert(`${p.name}: ${error.message}`);
    if (button) button.disabled = false;
    return false;
  }
}

async function reject(id, button) {
  const p = proposals.find((x) => x.id === id);
  if (!p || !confirm(`Reject the suggested price for "${p.name}"?`)) return;
  button.disabled = true;
  try {
    await fetchJSON(`/api/proposals/${id}/reject`, { method: 'POST' });
    proposals = proposals.filter((x) => x.id !== id);
    showAlert('');
    render();
  } catch (error) {
    showAlert(`${p.name}: ${error.message}`);
    button.disabled = false;
  }
}

async function approveShown() {
  const rows = visible();
  if (!rows.length) return;
  if (!confirm(`Approve ${rows.length} price${rows.length === 1 ? '' : 's'} with the markups selected and update Odoo?`)) return;
  const btn = document.getElementById('approveAllBtn');
  btn.disabled = true;
  showAlert('');
  let ok = 0;
  for (const p of rows) {
    if (await approve(p.id, null)) ok++;
    else break; // stop at the first failure so the error stays visible
  }
  render();
  if (ok === rows.length) showAlert(`Approved ${ok} price${ok === 1 ? '' : 's'} and updated Odoo.`, 'ok');
}

document.addEventListener('click', async (e) => {
  const chip = e.target.closest('.markup-chip');
  if (chip) {
    const id = Number(chip.dataset.id);
    if (chip.dataset.markup === 'custom') {
      if (chosen.get(id) === 'custom') return; // already selected: let the input take the click
      chosen.set(id, 'custom');
      render();
      const input = document.querySelector(`[data-custom="${id}"]`);
      if (input) input.focus();
    } else {
      chosen.set(id, Number(chip.dataset.markup));
      render();
    }
    return;
  }
  const tab = e.target.closest('.tab-btn');
  if (tab) {
    if (tab.dataset.dir) activeDir = tab.dataset.dir;
    else activeGroup = tab.dataset.group;
    render();
    return;
  }
  const approveBtn = e.target.closest('[data-approve]');
  if (approveBtn) {
    showAlert('');
    if (await approve(Number(approveBtn.dataset.approve), approveBtn)) render();
    return;
  }
  const rejectBtn = e.target.closest('[data-reject]');
  if (rejectBtn) reject(Number(rejectBtn.dataset.reject), rejectBtn);
});

// Typing in a custom box updates only that row's price text, so the input keeps focus.
document.addEventListener('input', (e) => {
  const input = e.target.closest('[data-custom]');
  if (!input) return;
  const id = Number(input.dataset.custom);
  const p = proposals.find((x) => x.id === id);
  if (!p) return;
  chosen.set(id, 'custom');
  customValues.set(id, input.value);
  document.getElementById(`cp-${id}`).textContent = customPriceText(p);
  document.getElementById(`diff-${id}`).innerHTML = diffBadgeHtml(p);
  input.closest('.markup-chip').classList.add('selected');
  input.closest('tr').querySelectorAll('.markup-chip:not(.markup-custom)').forEach((c) => c.classList.remove('selected'));
});

async function rejectShown() {
  const rows = visible();
  if (!rows.length) return;
  if (!confirm(`Reject ${rows.length} suggested price${rows.length === 1 ? '' : 's'}? Odoo is not changed.`)) return;
  const btn = document.getElementById('rejectAllBtn');
  btn.disabled = true;
  showAlert('');
  try {
    const r = await fetchJSON('/api/proposals/reject-many', { method: 'POST', body: JSON.stringify({ ids: rows.map((p) => p.id) }) });
    const gone = new Set(rows.map((p) => p.id));
    proposals = proposals.filter((p) => !gone.has(p.id));
    showAlert(`Rejected ${r.rejected} price${r.rejected === 1 ? '' : 's'}.`, 'ok');
  } catch (error) {
    showAlert(error.message);
  }
  render();
}

document.getElementById('search').addEventListener('input', render);
document.getElementById('approveAllBtn').addEventListener('click', approveShown);
document.getElementById('rejectAllBtn').addEventListener('click', rejectShown);

async function load() {
  try {
    const data = await fetchJSON('/api/proposals');
    proposals = data.proposals;
    markups = data.markupOptions;
    categories = data.categories;
    render();
  } catch (error) {
    showAlert(error.message);
  }
}

// ---- Automatic pricing run: status bar, Run now button, products it could not price ----

let runTimer = null;

function runSummary(run) {
  const when = formatDateTime(run.finished_at || run.created_at);
  const trigger = { manual: 'manual', scheduled: 'scheduled', agent: 'started by the agent' }[run.trigger] || run.trigger;
  if (run.status === 'running') {
    return `Pricing run in progress: ${run.done} of ${run.total} products checked, ${run.submitted} priced so far...`;
  }
  const base = `Last run ${when} (${trigger}): ${run.total} checked, ${run.submitted} priced, ${run.skipped + run.failed} couldn't be priced.`;
  if (run.status === 'done') return run.message ? `${base} ${run.message}` : base;
  return `${base} ${run.status === 'aborted' ? 'Stopped early.' : 'Failed.'} ${run.message || ''}`;
}

function renderUnpriced(items) {
  document.getElementById('unpricedPanel').style.display = items.length ? 'block' : 'none';
  document.getElementById('unpricedCount').textContent = items.length;
  document.getElementById('unpricedBody').innerHTML = items
    .map((i) => `
      <tr>
        <td><div class="product-name">${escapeHtml(i.name)}</div><div class="product-meta">${escapeHtml(i.sku || '')}${i.outcome === 'failed' ? ' &middot; failed' : ''}</div></td>
        <td class="num">${formatMoney(i.current_price)}</td>
        <td>${escapeHtml(i.reason || '')}${i.query ? `<div class="product-meta">Searched: ${escapeHtml(i.query)}</div>` : ''}</td>
        <td class="row-actions" style="flex-direction:row;"><button class="btn btn-sm" data-nolisting="${i.product_id}" title="The shops don't carry it: skip it for 30 days"><i class="fas fa-ban"></i> No listing</button> <a class="btn btn-sm" href="/lookup?q=${encodeURIComponent((i.query || '').split(' | ')[0] || i.name)}"><i class="fas fa-magnifying-glass"></i> Lookup</a></td>
      </tr>`)
    .join('');
}

async function refreshRun() {
  clearTimeout(runTimer);
  try {
    const { run, items } = await fetchJSON('/api/runs/latest');
    const wasRunning = document.getElementById('runBtn').disabled;
    document.getElementById('runStatus').textContent = run ? runSummary(run) : 'No pricing run yet.';
    renderUnpriced(items);
    const running = Boolean(run && run.status === 'running');
    document.getElementById('runBtn').disabled = running;
    if (running) runTimer = setTimeout(refreshRun, 4000);
    else if (wasRunning) load(); // a run just finished: pick up its new suggestions
  } catch (error) {
    document.getElementById('runStatus').textContent = error.message;
  }
}

document.getElementById('unpricedBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-nolisting]');
  if (!btn) return;
  btn.disabled = true;
  try {
    await fetchJSON(`/api/products/${btn.dataset.nolisting}/no-listing`, {
      method: 'PUT',
      body: JSON.stringify({ days: 30, note: 'Marked by hand: the shops do not list it' }),
    });
    refreshRun();
  } catch (error) {
    showAlert(error.message);
    btn.disabled = false;
  }
});

document.getElementById('runBtn').addEventListener('click', async () => {
  if (!confirm('Price every tracked product now? This checks several shops per product and can take a few minutes.')) return;
  showAlert('');
  try {
    await fetchJSON('/api/runs', { method: 'POST', body: JSON.stringify({}) });
    document.getElementById('runBtn').disabled = true;
    refreshRun();
  } catch (error) {
    showAlert(error.message);
  }
});

load();
refreshRun();
