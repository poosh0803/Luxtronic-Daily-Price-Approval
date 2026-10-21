let proposals = [];

function showAlert(message, type = 'danger') {
  document.getElementById('alertBox').innerHTML = message
    ? `<div class="alert alert-${type}">${escapeHtml(message)}</div>`
    : '';
}

const STATUS_BADGES = {
  approved: ['badge-ok', 'Approved'],
  rejected: ['badge-grey', 'Rejected'],
  reverted: ['badge-warn', 'Reverted'],
};

function markupText(p) {
  if (p.status === 'rejected') return '-';
  const m = Number(p.approved_markup);
  return `${m >= 0 ? '+' : '-'}${Math.abs(m)}`;
}

function historyRow(p) {
  const [cls, label] = STATUS_BADGES[p.status] || ['badge-grey', p.status];
  const decided = p.status === 'reverted' ? p.reverted_at : p.decided_at;
  const revertBtn = p.revertable
    ? `<button class="btn btn-sm" data-revert="${p.id}"><i class="fas fa-rotate-left"></i> Revert</button>`
    : '';
  return `
    <tr>
      <td>${formatDateTime(decided)}</td>
      <td><div class="product-name">${escapeHtml(p.name)}</div><div class="product-meta">${escapeHtml(p.category)}</div></td>
      <td class="num">${formatMoney(p.current_price)}</td>
      <td class="num">${formatMoney(p.market_price)}${p.approved_base_retailer ? `<div class="product-meta">base: ${escapeHtml(p.approved_base_retailer)} ${formatMoney(p.approved_base)}</div>` : ''}</td>
      <td>${markupText(p)}</td>
      <td class="num"><strong>${p.status === 'rejected' ? '-' : formatMoney(p.approved_price)}</strong></td>
      <td><span class="badge ${cls}">${label}</span></td>
      <td>${revertBtn}</td>
    </tr>`;
}

function render() {
  document.getElementById('historyBody').innerHTML = proposals.map(historyRow).join('');
  document.getElementById('emptyState').style.display = proposals.length ? 'none' : 'block';
}

async function load() {
  try {
    proposals = (await fetchJSON('/api/proposals?status=history')).proposals;
    render();
  } catch (error) {
    showAlert(error.message);
  }
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-revert]');
  if (!btn) return;
  const p = proposals.find((x) => x.id === Number(btn.dataset.revert));
  if (!p) return;
  if (!confirm(`Set "${p.name}" back to ${formatMoney(p.current_price)} in Odoo (currently ${formatMoney(p.approved_price)})?`)) return;
  btn.disabled = true;
  showAlert('');
  try {
    const r = await fetchJSON(`/api/proposals/${p.id}/revert`, { method: 'POST' });
    await load();
    showAlert(`Reverted. Odoo is back to ${formatMoney(r.restoredPrice)}.`, 'ok');
  } catch (error) {
    showAlert(`${p.name}: ${error.message}`);
    btn.disabled = false;
  }
});

load();
