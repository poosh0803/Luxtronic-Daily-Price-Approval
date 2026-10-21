import express from 'express';
import pool from '../db.js';
import { requireAgentKey } from '../auth.js';
import { syncProductsFromOdoo } from '../sync.js';
import { startRun, isRunning } from '../runner.js';
import { createProposal } from '../proposals.js';
import { lookupHandler } from './lookup.js';
import { setSearchHint, setNoListing } from './products.js';
import { latestRunWithItems, runItems } from './runs.js';
const router = express.Router();

router.use(requireAgentKey);

const fail = (res, label, error, status = 500) => {
  console.error(`${label}:`, error.message);
  res.status(status).json({ success: false, message: error.message });
};

// ---- Windows into the system (read-only) -------------------------------------------------

// One-call overview: what is waiting, what the last run did, what it could not price.
router.get('/status', async (req, res) => {
  try {
    const [{ rows: [counts] }, latest] = await Promise.all([
      pool.query(`SELECT
          (SELECT count(*) FROM products WHERE tracked)::int AS tracked_products,
          (SELECT count(*) FROM proposals WHERE status = 'pending')::int AS pending_proposals,
          (SELECT count(*) FROM proposals WHERE status = 'approved' AND decided_at > now() - interval '7 days')::int AS approved_last_7_days`),
      latestRunWithItems(),
    ]);
    res.json({ success: true, running: isRunning(), ...counts, latestRun: latest.run, unpriced: latest.items });
  } catch (error) { fail(res, 'Agent status failed', error); }
});

// Proposals as the approver sees them. ?status=pending (default) | history | all
router.get('/proposals', async (req, res) => {
  try {
    const filter = { history: `pr.status IN ('approved', 'rejected', 'reverted')`, all: 'TRUE' }[req.query.status] || `pr.status = 'pending'`;
    const { rows } = await pool.query(
      `SELECT pr.id, pr.status, pr.market_price, pr.current_price, pr.retailer_prices, pr.notes,
              pr.approved_base, pr.approved_base_retailer, pr.approved_markup, pr.approved_price, pr.decided_at, pr.created_at,
              p.id AS product_id, p.odoo_id, p.sku, p.name, p.category
         FROM proposals pr JOIN products p ON p.id = pr.product_id
        WHERE ${filter} ORDER BY pr.created_at DESC LIMIT 500`,
    );
    res.json({ success: true, count: rows.length, proposals: rows });
  } catch (error) { fail(res, 'Agent proposals failed', error); }
});

router.get('/runs', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM runs ORDER BY id DESC LIMIT 30');
    res.json({ success: true, runs: rows });
  } catch (error) { fail(res, 'Agent runs failed', error); }
});

// Every product a run looked at. ?outcome=skipped,failed,submitted (default: all three)
router.get('/runs/:id', async (req, res) => {
  try {
    const outcomes = String(req.query.outcome || 'submitted,skipped,failed').split(',');
    const { rows: runs } = await pool.query('SELECT * FROM runs WHERE id = $1', [req.params.id]);
    if (!runs.length) return res.status(404).json({ success: false, message: 'Run not found' });
    res.json({ success: true, run: runs[0], items: await runItems(runs[0].id, outcomes) });
  } catch (error) { fail(res, 'Agent run detail failed', error); }
});

// The product list. ?sync=1 refreshes from Odoo first.
router.get('/products', async (req, res) => {
  try {
    if (req.query.sync === '1') await syncProductsFromOdoo();
    const { rows } = await pool.query(
      `SELECT id, odoo_id, sku, name, category, category_group, current_price, qty_available, search_hint, no_listing_until, no_listing_note
         FROM products WHERE tracked ORDER BY category_group, name`,
    );
    res.json({ success: true, count: rows.length, products: rows });
  } catch (error) { fail(res, 'Agent product list failed', error, 502); }
});

// Market prices for a search term (StaticICE + shops' own feeds). ?q=<model>&pages=1-3&verify=0
router.get('/lookup', lookupHandler);

// Set the search words the next pricing run tries first for a product. Body: { "query": "amd 9600x" } (null clears).
router.put('/products/:id/search-hint', setSearchHint);

// Record that the shops don't list a product so runs stop retrying it for a while.
// Body: { "days": 30, "note": "checked all four shops" } to mark, { "clear": true } to retry.
router.put('/products/:id/no-listing', setNoListing);

// ---- Actions ---------------------------------------------------------------------------------

// Starts the same automatic run as the "Run pricing now" button. Body (optional): { limit, group, sync }
router.post('/runs', async (req, res) => {
  try {
    const { limit, group, sync, includeZeroStock } = req.body || {};
    res.status(202).json({ success: true, runId: await startRun({ trigger: 'agent', limit, group, sync: sync !== false, includeZeroStock: includeZeroStock === true }) });
  } catch (error) {
    fail(res, 'Agent run start failed', error, error.code === 'RUN_IN_PROGRESS' ? 409 : 500);
  }
});

// Submit suggestions yourself (e.g. for a product the runner skipped).
// Body: { proposals: [{ productId | odooId | sku, retailerPrices: [{retailer, price, inStock?, url?}], notes? }] }
// Each item succeeds or fails on its own; the response lists both.
router.post('/proposals', async (req, res) => {
  const items = req.body?.proposals;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'proposals must be a non-empty array' });
  }

  const created = [];
  const failed = [];
  for (const [index, item] of items.entries()) {
    try {
      const lookup = item.productId ? ['id', item.productId] : item.odooId ? ['odoo_id', item.odooId] : item.sku ? ['sku', item.sku] : null;
      if (!lookup) throw new Error('productId, odooId or sku is required');
      const found = await pool.query(`SELECT * FROM products WHERE ${lookup[0]} = $1 AND tracked LIMIT 1`, [lookup[1]]);
      if (!found.rows.length) throw new Error('No tracked product matches');
      const product = found.rows[0];
      const { proposalId, marketPrice } = await createProposal(product, item.retailerPrices, item.notes);
      created.push({ index, proposalId, productId: product.id, marketPrice });
    } catch (error) {
      failed.push({ index, message: error.message });
    }
  }

  if (failed.length) console.error(`Agent submission: ${failed.length} of ${items.length} items failed`);
  res.status(created.length ? 201 : 400).json({ success: created.length > 0, created, failed });
});

export default router;
