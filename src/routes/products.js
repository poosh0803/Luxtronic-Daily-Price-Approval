import express from 'express';
import pool from '../db.js';
import { syncProductsFromOdoo } from '../sync.js';
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*,
              EXISTS (SELECT 1 FROM proposals pr WHERE pr.product_id = p.id AND pr.status = 'pending') AS has_pending,
              last_item.outcome AS last_outcome,
              last_item.reason AS last_reason
         FROM products p
         LEFT JOIN LATERAL (
           SELECT ri.outcome, ri.reason FROM run_items ri
            WHERE ri.product_id = p.id ORDER BY ri.id DESC LIMIT 1
         ) last_item ON true
        ORDER BY p.category_group, p.name`,
    );
    res.json({ success: true, products: rows });
  } catch (error) {
    console.error('List products failed:', error.message);
    res.status(500).json({ success: false, message: 'Failed to load products', error: error.message });
  }
});

router.put('/:id/tracked', async (req, res) => {
  try {
    if (typeof req.body.tracked !== 'boolean') {
      return res.status(400).json({ success: false, message: 'tracked must be true or false' });
    }
    const { rows } = await pool.query(
      'UPDATE products SET tracked = $1 WHERE id = $2 RETURNING *',
      [req.body.tracked, req.params.id],
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Product not found' });
    res.json({ success: true, product: rows[0] });
  } catch (error) {
    console.error('Update tracked failed:', error.message);
    res.status(500).json({ success: false, message: 'Failed to update product', error: error.message });
  }
});

// Search words a pricing run tries first for this product. Empty / null clears them.
export async function setSearchHint(req, res) {
  try {
    const raw = req.body.query;
    if (raw !== null && raw !== undefined && typeof raw !== 'string') {
      return res.status(400).json({ success: false, message: 'query must be text or null' });
    }
    const hint = String(raw || '').trim().slice(0, 120) || null;
    const { rows } = await pool.query('UPDATE products SET search_hint = $1 WHERE id = $2 RETURNING id, name, search_hint', [hint, req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Product not found' });
    res.json({ success: true, product: rows[0] });
  } catch (error) {
    console.error('Set search hint failed:', error.message);
    res.status(500).json({ success: false, message: 'Failed to save search words', error: error.message });
  }
}

// Marks a product as "the shops don't list this": pricing runs skip it until the mark expires.
// Body: { days?: 1-365 (default 30), note?: text } to mark, or { clear: true } to retry it on the next run.
export async function setNoListing(req, res) {
  try {
    const body = req.body || {};
    let until = null;
    let note = null;
    if (body.clear !== true) {
      const days = body.days === undefined ? 30 : Number(body.days);
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        return res.status(400).json({ success: false, message: 'days must be a whole number from 1 to 365' });
      }
      until = new Date(Date.now() + days * 86400000);
      note = String(body.note || '').trim().slice(0, 300) || null;
    }
    const { rows } = await pool.query(
      'UPDATE products SET no_listing_until = $1, no_listing_note = $2 WHERE id = $3 RETURNING id, name, no_listing_until, no_listing_note',
      [until, note, req.params.id],
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Product not found' });
    res.json({ success: true, product: rows[0] });
  } catch (error) {
    console.error('Set no-listing failed:', error.message);
    res.status(500).json({ success: false, message: 'Failed to update the product', error: error.message });
  }
}

router.put('/:id/search-hint', setSearchHint);
router.put('/:id/no-listing', setNoListing);

router.post('/sync', async (req, res) => {
  try {
    res.json({ success: true, ...(await syncProductsFromOdoo()) });
  } catch (error) {
    console.error('Odoo sync failed:', error.message);
    res.status(502).json({ success: false, message: error.message });
  }
});

export default router;
