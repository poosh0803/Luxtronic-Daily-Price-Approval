import pool from './db.js';
import { cleanRetailerPrices, marketPriceFrom } from './utils/pricing.js';

// Creates a pending proposal for a product, superseding any earlier pending one.
// Shared by the agent API and the automatic runner so both follow the same rules.
export async function createProposal(product, rawRetailerPrices, extraNotes = '') {
  const retailerPrices = cleanRetailerPrices(rawRetailerPrices);
  const { marketPrice, noStock } = marketPriceFrom(retailerPrices);
  const notes = [extraNotes ? String(extraNotes).slice(0, 1000) : null, noStock ? 'No retailer showed stock - lowest listed price used.' : null]
    .filter(Boolean).join(' ');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE proposals SET status = 'superseded' WHERE product_id = $1 AND status = 'pending'`, [product.id]);
    const { rows } = await client.query(
      `INSERT INTO proposals (product_id, market_price, retailer_prices, current_price, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [product.id, marketPrice, JSON.stringify(retailerPrices), product.current_price, notes || null],
    );
    await client.query('COMMIT');
    return { proposalId: rows[0].id, marketPrice };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
