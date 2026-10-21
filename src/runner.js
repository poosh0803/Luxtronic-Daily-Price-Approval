import pool from './db.js';
import { syncProductsFromOdoo } from './sync.js';
import { lookupPrices } from './lookup.js';
import { buildQueries, evaluate } from './matching.js';
import { createProposal } from './proposals.js';

const PRODUCT_GAP_MS = 400; // breathing room between products, on top of the per-shop spacing in lookup.js
const MAX_CONSECUTIVE_FAILURES = 5; // several in a row means a source is down or blocking us: stop, don't hammer
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let activeRunId = null;

export const isRunning = () => activeRunId !== null;

// Starts a run in the background and returns its id straight away.
// options: { trigger, sync (default true), limit, group, includeZeroStock (default false) }
export async function startRun({ trigger = 'manual', sync = true, limit, group, includeZeroStock = false } = {}) {
  if (activeRunId !== null) {
    const error = new Error(`A run is already in progress (#${activeRunId})`);
    error.code = 'RUN_IN_PROGRESS';
    throw error;
  }
  const { rows } = await pool.query(`INSERT INTO runs (trigger) VALUES ($1) RETURNING id`, [trigger]);
  const runId = rows[0].id;
  activeRunId = runId;

  execute(runId, { sync, limit, group, includeZeroStock }).catch((error) => {
    console.error(`Run ${runId} crashed:`, error.message);
    return pool.query(`UPDATE runs SET status = 'failed', message = $2, finished_at = now() WHERE id = $1`, [runId, error.message]);
  }).finally(() => { activeRunId = null; });

  return runId;
}

async function execute(runId, { sync, limit, group, includeZeroStock }) {
  if (sync) {
    try {
      await syncProductsFromOdoo();
    } catch (error) {
      // Not fatal: price the products we already have, but say so on the run.
      await pool.query(`UPDATE runs SET message = $2 WHERE id = $1`, [runId, `Odoo sync failed, used existing product list: ${error.message}`]);
    }
  }

  const params = [];
  let where = 'WHERE tracked';
  if (group) { params.push(group); where += ` AND lower(category_group) = lower($${params.length})`; }

  // Nothing on hand means nothing to sell, so don't spend lookups on it (qty comes from the Odoo sync above).
  let skippedNoStock = 0;
  if (!includeZeroStock) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM products ${where} AND qty_available <= 0`, params);
    skippedNoStock = rows[0].n;
    where += ' AND qty_available > 0';
  }

  // Products marked "no listing" (the shops don't carry them) are left alone until the mark expires.
  const { rows: marked } = await pool.query(
    `SELECT count(*)::int AS n FROM products ${where} AND no_listing_until > now()`, params);
  const skippedNoListing = marked[0].n;
  where += ' AND (no_listing_until IS NULL OR no_listing_until <= now())';

  let sql = `SELECT id, name, sku, category_group, current_price, search_hint FROM products ${where} ORDER BY category_group, name`;
  if (limit) { params.push(Number(limit)); sql += ` LIMIT $${params.length}`; }
  const { rows: products } = await pool.query(sql, params);
  const plural = (n) => (n === 1 ? '' : 's');
  const notes = [
    skippedNoStock ? `Skipped ${skippedNoStock} product${plural(skippedNoStock)} with no stock in Odoo.` : '',
    skippedNoListing ? `Skipped ${skippedNoListing} marked "no listing".` : '',
  ].filter(Boolean).join(' ');
  await pool.query(
    `UPDATE runs SET total = $2,
            message = NULLIF(concat_ws(' ', message, $3::text), '') WHERE id = $1`,
    [runId, products.length, notes],
  );

  let consecutiveFailures = 0;
  for (const product of products) {
    const result = await priceOne(product);
    await pool.query(
      `INSERT INTO run_items (run_id, product_id, outcome, reason, query, retailer_prices, proposal_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [runId, product.id, result.outcome, result.reason || null, result.query || null, JSON.stringify(result.retailerPrices || []), result.proposalId || null],
    );
    const column = { submitted: 'submitted', skipped: 'skipped', failed: 'failed' }[result.outcome];
    await pool.query(`UPDATE runs SET done = done + 1, ${column} = ${column} + 1 WHERE id = $1`, [runId]);

    consecutiveFailures = result.outcome === 'failed' ? consecutiveFailures + 1 : 0;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      await pool.query(
        `UPDATE runs SET status = 'aborted', message = $2, finished_at = now() WHERE id = $1`,
        [runId, `Stopped after ${MAX_CONSECUTIVE_FAILURES} lookups failed in a row (last: ${result.reason}). A price source may be down or blocking requests.`],
      );
      return;
    }
    await sleep(PRODUCT_GAP_MS);
  }
  await pool.query(`UPDATE runs SET status = 'done', finished_at = now() WHERE id = $1`, [runId]);
}

// Search texts in the order they are tried: the product's own search words (set by a person or the
// agent) first, then the ones built from the Odoo name, most specific first.
export function searchesFor(product) {
  const hint = String(product.search_hint || '').trim();
  return [...new Set([hint, ...buildQueries(product.name, product.category_group)].filter(Boolean))];
}

async function priceOne(product) {
  const queries = searchesFor(product);
  if (!queries.length) return { outcome: 'skipped', reason: 'Could not build a search from the product name', query: '' };

  let best = null; // the closest a skipped attempt got, shown as the reason if nothing works
  let lastError = null;
  const tried = [];
  for (const query of queries) {
    tried.push(query);
    try {
      const lookup = await lookupPrices(query, 2, { verify: true });
      const verdict = evaluate(product, lookup.results);
      if (verdict.outcome === 'submit') {
        const { proposalId } = await createProposal(product, verdict.retailerPrices, verdict.notes);
        return { outcome: 'submitted', query, retailerPrices: verdict.retailerPrices, proposalId };
      }
      if (!best || verdict.retailerPrices.length > best.retailerPrices.length) best = { ...verdict, query };
    } catch (error) {
      console.error(`Pricing "${product.name}" via "${query}" failed:`, error.message);
      lastError = error;
    }
  }

  const query = tried.join(' | ');
  if (best) return { outcome: 'skipped', reason: best.reason, query, retailerPrices: best.retailerPrices };
  return { outcome: 'failed', reason: lastError ? lastError.message : 'No lookup completed', query };
}

// Any run left 'running' by a crash or restart is closed so the UI doesn't wait on it forever.
export async function closeStaleRuns() {
  await pool.query(`UPDATE runs SET status = 'aborted', message = COALESCE(message, 'Interrupted by a server restart'), finished_at = now() WHERE status = 'running'`);
}
