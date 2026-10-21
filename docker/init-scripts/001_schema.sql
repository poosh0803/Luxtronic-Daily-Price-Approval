-- Products mirrored from Odoo (PC parts only). Odoo stays the source of truth
-- for name/SKU/price; this table exists so proposals have something stable to
-- point at and so a product can be switched in/out of daily pricing.
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  odoo_id INTEGER NOT NULL UNIQUE,            -- Odoo product.product id
  sku VARCHAR(100),                           -- Odoo default_code / barcode
  name TEXT NOT NULL,
  category VARCHAR(150) NOT NULL,             -- full Odoo category, e.g. 'GPU / Nvidia / RTX50'
  category_group VARCHAR(50) NOT NULL,        -- top-level segment, e.g. 'GPU'
  tracked BOOLEAN NOT NULL DEFAULT true,
  no_listing_until TIMESTAMPTZ,               -- set when the shops are known not to list it: pricing runs skip it until then
  no_listing_note TEXT,
  search_hint TEXT,                           -- search words set by a person or the agent; tried first by pricing runs
  current_price NUMERIC(10,2) NOT NULL DEFAULT 0,   -- Odoo list_price at last sync / approval
  qty_available NUMERIC(10,2) NOT NULL DEFAULT 0,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_products_group ON products (category_group);

-- One row per price suggestion from the agent. Retailer prices are kept as
-- JSONB so the retailer set can change without a migration; market_price is
-- computed server-side (lowest in-stock price) rather than trusted from the agent.
CREATE TABLE proposals (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products (id),
  market_price NUMERIC(10,2) NOT NULL,
  retailer_prices JSONB NOT NULL DEFAULT '[]',
  current_price NUMERIC(10,2) NOT NULL,       -- Odoo price when the proposal was submitted
  notes TEXT,
  status VARCHAR(12) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'superseded', 'reverted')),
  approved_base NUMERIC(10,2),                -- the price the markup was added to (market price, or a shop price the approver picked)
  approved_base_retailer VARCHAR(60),         -- which shop that was, when picked by hand
  approved_markup NUMERIC(8,2),
  approved_price NUMERIC(10,2),
  decided_at TIMESTAMPTZ,
  odoo_pushed_at TIMESTAMPTZ,
  reverted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_proposals_product ON proposals (product_id);
CREATE INDEX idx_proposals_status ON proposals (status);
-- A product has at most one open suggestion; a new submission supersedes the old one.
CREATE UNIQUE INDEX uniq_proposals_pending_per_product ON proposals (product_id) WHERE status = 'pending';

-- One row per automatic pricing run (manual button, schedule, or an agent kicking it off),
-- plus one row per product it looked at, so skipped / failed products are visible afterwards.
CREATE TABLE runs (
  id SERIAL PRIMARY KEY,
  trigger VARCHAR(10) NOT NULL CHECK (trigger IN ('manual', 'scheduled', 'agent')),
  status VARCHAR(10) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'aborted', 'failed')),
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  submitted INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE run_items (
  id SERIAL PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs (id),
  product_id INTEGER NOT NULL REFERENCES products (id),
  outcome VARCHAR(10) NOT NULL CHECK (outcome IN ('submitted', 'skipped', 'failed')),
  reason TEXT,
  query TEXT,
  retailer_prices JSONB NOT NULL DEFAULT '[]',   -- what the matcher found (also for skipped items)
  proposal_id INTEGER REFERENCES proposals (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_run_items_run ON run_items (run_id);
CREATE INDEX idx_run_items_product ON run_items (product_id);
