// Pure pricing helpers - no DB or network, so they are easy to unit test.

export function markupOptions() {
  const parsed = (process.env.MARKUP_OPTIONS || '0,5,10,15')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length ? parsed : [0, 5, 10, 15];
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Validates the retailer list an agent submits and returns a clean copy.
// Throws an Error with a readable message on bad input.
export function cleanRetailerPrices(list) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('retailerPrices must be a non-empty array');
  }
  return list.map((r, i) => {
    const retailer = String(r?.retailer || '').trim();
    const price = Number(r?.price);
    if (!retailer) throw new Error(`retailerPrices[${i}].retailer is required`);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`retailerPrices[${i}].price must be a positive number`);
    }
    return {
      retailer,
      price: round2(price),
      inStock: r.inStock !== false, // unknown counts as in stock; agent sends false when sold out
      url: r.url ? String(r.url).slice(0, 500) : null,
    };
  });
}

// Market price = lowest in-stock retailer price. If nothing is in stock anywhere
// the lowest listed price is used and `noStock` is flagged so the UI can warn.
export function marketPriceFrom(retailerPrices) {
  const inStock = retailerPrices.filter((r) => r.inStock);
  const pool = inStock.length ? inStock : retailerPrices;
  return { marketPrice: round2(Math.min(...pool.map((r) => r.price))), noStock: inStock.length === 0 };
}

// Top-level Odoo category, e.g. 'GPU / Nvidia / RTX50' -> 'GPU'.
export function categoryGroup(categoryName) {
  return String(categoryName || '').split('/')[0].trim();
}

export function pcCategories() {
  return (process.env.PC_CATEGORIES || 'CPU,GPU,DRAM,SSD,MB')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isPcCategory(categoryName) {
  return pcCategories().includes(categoryGroup(categoryName).toLowerCase());
}

// Configured categories in their original spelling and order, for UI tabs.
export function pcCategoryLabels() {
  return (process.env.PC_CATEGORIES || 'CPU,GPU,DRAM,SSD,MB').split(',').map((s) => s.trim()).filter(Boolean);
}
