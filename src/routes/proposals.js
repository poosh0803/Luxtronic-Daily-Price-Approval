import express from 'express';
import pool from '../db.js';
import { pushPrice, fetchPrice } from '../odoo.js';
import { markupOptions, pcCategoryLabels, resolveBase, round2 } from '../utils/pricing.js';
const router = express.Router();

const SELECT_PROPOSALS = `
  SELECT pr.*, p.name, p.sku, p.category, p.category_group, p.odoo_id
    FROM proposals pr JOIN products p ON p.id = pr.product_id`;

const MAX_CUSTOM_MARKUP = 1000; // AUD, either direction - a sanity bound against typos

// Approvals currently being pushed to Odoo, so a double-click can't push twice.
const inFlight = new Set();

router.get('/', async (req, res) => {
  try {
    const history = req.query.status === 'history';
    const { rows } = await pool.query(
      history
        ? `SELECT pr.*, p.name, p.sku, p.category, p.category_group, p.odoo_id,
                  (pr.status = 'approved' AND NOT EXISTS (
                     SELECT 1 FROM proposals later
                      WHERE later.product_id = pr.product_id AND later.status = 'approved'
                        AND later.decided_at > pr.decided_at)) AS revertable
             FROM proposals pr JOIN products p ON p.id = pr.product_id
            WHERE pr.status IN ('approved', 'rejected', 'reverted')
            ORDER BY COALESCE(pr.reverted_at, pr.decided_at) DESC LIMIT 300`
        : `${SELECT_PROPOSALS} WHERE pr.status = 'pending' ORDER BY p.category_group, p.name`,
    );
    res.json({ success: true, proposals: rows, markupOptions: markupOptions(), categories: pcCategoryLabels() });
  } catch (error) {
    console.error('List proposals failed:', error.message);
    res.status(500).json({ success: false, message: 'Failed to load proposals', error: error.message });
  }
});

router.post('/:id/approve', async (req, res) => {
  const id = Number(req.params.id);
  const markup = round2(Number(req.body.markup));
  const custom = req.body.custom === true;
  if (custom) {
    if (!Number.isFinite(markup) || Math.abs(markup) > MAX_CUSTOM_MARKUP) {
      return res.status(400).json({ success: false, message: `Custom markup must be a number between -${MAX_CUSTOM_MARKUP} and ${MAX_CUSTOM_MARKUP}` });
    }
  } else if (!markupOptions().includes(markup)) {
    return res.status(400).json({ success: false, message: `markup must be one of ${markupOptions().join(', ')}` });
  }
  if (inFlight.has(id)) return res.status(409).json({ success: false, message: 'Approval already in progress' });
  inFlight.add(id);

  try {
    const { rows } = await pool.query(`${SELECT_PROPOSALS} WHERE pr.id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Proposal not found' });
    const proposal = rows[0];
    if (proposal.status !== 'pending') {
      return res.status(409).json({ success: false, message: `Proposal is already ${proposal.status}` });
    }

    // The base the markup is added to: the market price, or a shop price the approver picked.
    // It must be one of this suggestion's own shop prices - anything else is covered by a Custom markup.
    const base = resolveBase(proposal.retailer_prices, proposal.market_price, req.body.basePrice);
    if (base.error) return res.status(400).json({ success: false, message: base.error });
    const { basePrice, retailer: baseRetailer } = base;
    const approvedPrice = round2(basePrice + markup);
    if (approvedPrice <= 0) {
      return res.status(400).json({ success: false, message: 'Final price must be above $0' });
    }

    // Odoo first: if it fails the proposal stays pending and can simply be retried.
    try {
      await pushPrice(proposal.odoo_id, approvedPrice);
    } catch (error) {
      console.error(`Odoo push failed for proposal ${id}:`, error.message);
      return res.status(502).json({ success: false, message: `Odoo update failed: ${error.message}` });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE proposals SET status = 'approved', approved_markup = $1, approved_price = $2,
                approved_base = $4, approved_base_retailer = $5,
                decided_at = now(), odoo_pushed_at = now() WHERE id = $3`,
        [markup, approvedPrice, id, basePrice, baseRetailer],
      );
      await client.query('UPDATE products SET current_price = $1 WHERE id = $2', [approvedPrice, proposal.product_id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      // Odoo already has the new price here - say so loudly rather than hide it.
      console.error(`Proposal ${id} pushed to Odoo but DB update failed:`, error.message);
      return res.status(500).json({ success: false, message: 'Price was written to Odoo but could not be recorded here', error: error.message });
    } finally {
      client.release();
    }

    res.json({ success: true, approvedPrice, markup, basePrice });
  } catch (error) {
    console.error('Approve failed:', error.message);
    res.status(500).json({ success: false, message: 'Failed to approve proposal', error: error.message });
  } finally {
    inFlight.delete(id);
  }
});

// Puts the price from before an approval back into Odoo. Only the product's most
// recent approval can be reverted, and only while Odoo still holds the price we set.
router.post('/:id/revert', async (req, res) => {
  const id = Number(req.params.id);
  if (inFlight.has(id)) return res.status(409).json({ success: false, message: 'Another action is in progress' });
  inFlight.add(id);

  try {
    const { rows } = await pool.query(`${SELECT_PROPOSALS} WHERE pr.id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Proposal not found' });
    const proposal = rows[0];
    if (proposal.status !== 'approved') {
      return res.status(409).json({ success: false, message: `Only approved prices can be reverted (this one is ${proposal.status})` });
    }

    const later = await pool.query(
      `SELECT 1 FROM proposals WHERE product_id = $1 AND status = 'approved' AND decided_at > (SELECT decided_at FROM proposals WHERE id = $2) LIMIT 1`,
      [proposal.product_id, id],
    );
    if (later.rows.length) {
      return res.status(409).json({ success: false, message: 'A newer approval exists for this product - revert that one first' });
    }

    const approvedPrice = round2(proposal.approved_price);
    const previousPrice = round2(proposal.current_price);

    let odooPrice;
    try {
      odooPrice = round2(await fetchPrice(proposal.odoo_id));
    } catch (error) {
      console.error(`Odoo price check failed for proposal ${id}:`, error.message);
      return res.status(502).json({ success: false, message: `Could not read the price from Odoo: ${error.message}` });
    }
    if (odooPrice !== approvedPrice) {
      return res.status(409).json({
        success: false,
        message: `Odoo now shows ${odooPrice.toFixed(2)}, not the approved ${approvedPrice.toFixed(2)} - it was changed since, so nothing was reverted`,
      });
    }

    try {
      await pushPrice(proposal.odoo_id, previousPrice);
    } catch (error) {
      console.error(`Odoo revert push failed for proposal ${id}:`, error.message);
      return res.status(502).json({ success: false, message: `Odoo update failed: ${error.message}` });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE proposals SET status = 'reverted', reverted_at = now() WHERE id = $1`, [id]);
      await client.query('UPDATE products SET current_price = $1 WHERE id = $2', [previousPrice, proposal.product_id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`Proposal ${id} reverted in Odoo but DB update failed:`, error.message);
      return res.status(500).json({ success: false, message: 'Price was reverted in Odoo but could not be recorded here', error: error.message });
    } finally {
      client.release();
    }

    res.json({ success: true, restoredPrice: previousPrice });
  } catch (error) {
    console.error('Revert failed:', error.message);
    res.status(500).json({ success: false, message: 'Failed to revert', error: error.message });
  } finally {
    inFlight.delete(id);
  }
});

// Rejects many pending proposals at once (the page sends the ids it is showing).
router.post('/reject-many', async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) return res.status(400).json({ success: false, message: 'ids must be a non-empty array' });
    const { rowCount } = await pool.query(
      `UPDATE proposals SET status = 'rejected', decided_at = now()
        WHERE id = ANY($1::int[]) AND status = 'pending'`,
      [ids],
    );
    res.json({ success: true, rejected: rowCount });
  } catch (error) {
    console.error('Bulk reject failed:', error.message);
    res.status(500).json({ success: false, message: 'Failed to reject proposals', error: error.message });
  }
});

router.post('/:id/reject', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE proposals SET status = 'rejected', decided_at = now()
        WHERE id = $1 AND status = 'pending' RETURNING id`,
      [req.params.id],
    );
    if (!rows.length) return res.status(409).json({ success: false, message: 'Proposal not found or no longer pending' });
    res.json({ success: true });
  } catch (error) {
    console.error('Reject failed:', error.message);
    res.status(500).json({ success: false, message: 'Failed to reject proposal', error: error.message });
  }
});

export default router;
