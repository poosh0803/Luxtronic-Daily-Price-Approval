import express from 'express';
import pool from '../db.js';
import { startRun } from '../runner.js';
const router = express.Router();

// Shared with the agent API so both see exactly the same run data.
export async function latestRunWithItems() {
  const { rows: runs } = await pool.query('SELECT * FROM runs ORDER BY id DESC LIMIT 1');
  if (!runs.length) return { run: null, items: [] };
  return { run: runs[0], items: await runItems(runs[0].id, ['skipped', 'failed']) };
}

export async function runItems(runId, outcomes) {
  const { rows } = await pool.query(
    `SELECT ri.id, ri.outcome, ri.reason, ri.query, ri.retailer_prices, ri.proposal_id,
            p.id AS product_id, p.name, p.sku, p.category_group, p.current_price, p.no_listing_until, p.no_listing_note
       FROM run_items ri JOIN products p ON p.id = ri.product_id
      WHERE ri.run_id = $1 AND ri.outcome = ANY($2::text[])
        AND (p.no_listing_until IS NULL OR p.no_listing_until <= now() OR ri.outcome = 'submitted')
      ORDER BY p.category_group, p.name`,
    [runId, outcomes],
  );
  return rows;
}

// Latest run + the products it could not price (skipped / failed). The Pending page polls this.
router.get('/latest', async (req, res) => {
  try {
    res.json({ success: true, ...(await latestRunWithItems()) });
  } catch (error) {
    console.error('Latest run failed:', error.message);
    res.status(500).json({ success: false, message: 'Failed to load the latest run', error: error.message });
  }
});

// Body (all optional): { limit: 10, group: "GPU", sync: false }
router.post('/', async (req, res) => {
  try {
    const { limit, group, sync, includeZeroStock } = req.body || {};
    const id = await startRun({ trigger: 'manual', limit, group, sync: sync !== false, includeZeroStock: includeZeroStock === true });
    res.status(202).json({ success: true, runId: id });
  } catch (error) {
    if (error.code === 'RUN_IN_PROGRESS') return res.status(409).json({ success: false, message: error.message });
    console.error('Start run failed:', error.message);
    res.status(500).json({ success: false, message: 'Failed to start the run', error: error.message });
  }
});

export default router;
