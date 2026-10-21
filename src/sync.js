import pool from './db.js';
import { fetchAllProducts } from './odoo.js';
import { categoryGroup, isPcCategory } from './utils/pricing.js';

// Pulls PC-part products from Odoo and upserts them. New products start tracked;
// an existing product's `tracked` flag is never touched, so a manual off-switch sticks.
export async function syncProductsFromOdoo() {
  const all = await fetchAllProducts();
  const parts = all.filter((p) => Array.isArray(p.categ_id) && isPcCategory(p.categ_id[1]));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of parts) {
      const category = p.categ_id[1];
      await client.query(
        `INSERT INTO products (odoo_id, sku, name, category, category_group, current_price, qty_available, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (odoo_id) DO UPDATE SET
           sku = EXCLUDED.sku, name = EXCLUDED.name, category = EXCLUDED.category,
           category_group = EXCLUDED.category_group, current_price = EXCLUDED.current_price,
           qty_available = EXCLUDED.qty_available, last_synced_at = now()`,
        [p.id, p.default_code || p.barcode || null, p.display_name, category, categoryGroup(category), p.list_price || 0, p.qty_available || 0],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { fetched: all.length, matched: parts.length };
}
