// Thin client for Luxtronic-Odoo-API (the LAN service that talks to Odoo Online).

const base = () => (process.env.ODOO_API_URL || 'http://localhost:4001').replace(/\/$/, '');

async function request(path, options) {
  let res;
  try {
    res = await fetch(`${base()}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new Error(`Odoo API unreachable (${err.message})`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Odoo API error (${res.status})`);
  return data;
}

export async function fetchAllProducts() {
  const data = await request('/inventory/products/all');
  return data.products;
}

export async function pushPrice(odooProductId, price) {
  return request('/inventory/products/price', {
    method: 'POST',
    body: JSON.stringify({ productId: odooProductId, price }),
  });
}

export async function fetchPrice(odooProductId) {
  const data = await request(`/inventory/products/${encodeURIComponent(odooProductId)}/price`);
  return Number(data.price);
}
