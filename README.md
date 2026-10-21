# Luxtronic Daily Price Approval

Internal LAN website for approving PC-part price changes. Prices are gathered by code, a person approves them, and only then does anything reach Odoo.

1. A **pricing run** (button, schedule, or the agent API) syncs PC parts (CPU, GPU, RAM, SSD, motherboards) from Odoo, looks up prices at Centrecom, Mwave, Scorptec and PC Case Gear, keeps only listings that are clearly the same product, and creates **suggestions**. Products it can't match with confidence are listed under **Couldn't price** with the reason.
2. You open the site and see each suggestion's shop prices, the market price (lowest in-stock) and the change against Odoo. Pick **+0 / +5 / +10 / +15** (AUD on top of market) or a **Custom** amount, then approve.
3. Approving writes the new sales price to Odoo. Rejecting does nothing. **Revert** on the History page puts the previous price back.

A Claude agent is optional: it can look inside the system through a key-protected API and help with products the code couldn't price (see [AGENT.md](AGENT.md)). Design decisions, findings and the deploy checklist are in [docs/NOTES.md](docs/NOTES.md).

Stack and layout follow the shared Luxtronic guidelines (`../LUXTRONIC-*-GUIDELINES.md`, `../LUXTRONIC-*-CONVENTIONS.md`): Node ESM + Express, raw `pg`, plain HTML/CSS/JS with no build step, amber theme with a dark-mode toggle.

## Setup

```bash
npm install
cp .env.example .env            # set AGENT_API_KEY and ODOO_API_URL
docker compose -f docker/docker-compose.yml up -d    # dev Postgres on 5437 (empty schema, no seed data)
npm start                        # http://localhost:8006
npm test                         # node's built-in test runner, no database or network needed
```

Then open **Products** and click **Sync from Odoo** (or let a run do it). Needs [Luxtronic-Odoo-API](https://github.com/poosh0803/Luxtronic-Odoo-API) reachable at `ODOO_API_URL`.

## Pages

| Page | Purpose |
|---|---|
| `/` Pending | Suggestions with category / All-Drop-Rise filters and a search box; per-row markup chips (+0 +5 +10 +15 and Custom); approve / reject, or **Approve shown** / **Reject shown** in bulk. Run bar: **Run pricing now**, progress, last result. **Couldn't price** panel with Lookup and **No listing** buttons |
| `/history` | Last 300 decisions. **Revert** (latest approval per product only) restores the previous price in Odoo, and refuses if Odoo's price was changed since |
| `/products` | Synced Odoo PC parts: track on/off, per-product **Search words**, status (Awaiting approval / Couldn't price / No listing / Tracked), Hide stock = 0 |
| `/lookup` | Search a model across StaticICE plus Centrecom, Mwave, Scorptec and PC Case Gear's own pages. Main-4 / all shops, hide bundles and out-of-stock, CSV export |

## API

Responses are `{ success: true, ... }` or `{ success: false, message }`.

**UI (no auth, LAN-only)**
`GET /api/proposals[?status=history]`, `POST /api/proposals/:id/approve {markup, custom?}`, `POST /api/proposals/:id/reject`, `POST /api/proposals/reject-many {ids}`, `POST /api/proposals/:id/revert`, `GET /api/products`, `PUT /api/products/:id/tracked`, `PUT /api/products/:id/search-hint`, `PUT /api/products/:id/no-listing`, `POST /api/products/sync`, `GET /api/lookup?q=&pages=&verify=`, `POST /api/runs`, `GET /api/runs/latest`, `GET /api/config`.

**Agent (`Authorization: Bearer <AGENT_API_KEY>`)**
`GET /api/agent/status`, `/proposals`, `/runs`, `/runs/:id`, `/products[?sync=1]`, `/lookup`; `POST /api/agent/runs`, `/proposals`; `PUT /api/agent/products/:id/search-hint`, `/no-listing`. Details in [AGENT.md](AGENT.md).

## Pricing runs

- **Start:** the button, `POST /api/runs`, the agent API, or the schedule: set `AUTO_RUN_HOUR` (0-23, Australia/Sydney) and one run starts per day once that hour passes. Restarts never double-run; blank means off. One run at a time.
- **Which products:** tracked products **with stock in Odoo** (quantity above 0, refreshed by the sync at the start of the run). `{ "includeZeroStock": true }` includes the rest. Products marked **No listing** are skipped until the mark expires (30 days by default, then retried); **Retry** clears it early.
- **Search:** a product's own **Search words** are tried first, then up to two searches built from the Odoo name (brand + model + capacity, then brand + model, then the bare part number). Spec noise (wattage, pin counts, speeds, sockets, part numbers) is left out of searches.
- **Matching** (`src/matching.js`): model numbers, capacity and DDR generation (memory) must appear; variant words (Ti, Super, WiFi, II, ICE, Heatsink, White/Black) and board suffixes (B650M-**E** vs B650M-**A**) must agree; memory speed and CAS latency must not conflict; a listing quoting the product's own part number matches outright; bundles and used items are ignored.
- **Accepting a match:** the cheapest matching row per shop is kept, and it needs **2 of the 4 main shops**, prices within 60% of each other, and a market price within 3x of Odoo's. Anything else is **skipped with a reason**, never guessed.
- **Safety:** a run stops itself after 5 failed lookups in a row. Outcomes and reasons are stored in `runs` / `run_items`.

## Price sources (`src/lookup.js`)

| Source | Used for | Stock info |
|---|---|---|
| StaticICE | Price spread across Australian shops (also the link to each shop's product page) | no |
| Centrecom search API | Centrecom prices, sale price, stock | yes |
| Mwave (Shopify `suggest.json`) | Mwave prices and stock | yes |
| PC Case Gear product page | Re-checks the cheapest rows (price + stock from page markup) | yes |
| Scorptec product page | Same check, but Scorptec answers HTTP 403 to Node requests, so its rows stay StaticICE-only (`verified: false`) | no |

Only these fixed hosts are contacted; callers supply a search term, never a URL. Results are cached 10 minutes, StaticICE pages are fetched 0.5 s apart, shop pages 1 s apart per host, and a shop that answers 403 is left alone for 30 minutes.

## Behaviour worth knowing

- **Market price** = lowest in-stock shop price, computed server-side. If every shop is out of stock the lowest listed price is used and the suggestion is noted.
- **Final price** = market price + markup. Presets come from `MARKUP_OPTIONS`; **Custom** accepts any amount within ±$1000 as long as the final price stays above $0.
- **Approve** pushes to Odoo first; if Odoo fails, the suggestion stays pending and the error is shown so you can retry. A product has one pending suggestion at a time, and a newer run replaces it.
- A market move over 20% from the current price shows a "Big change - check" badge.
- `PC_CATEGORIES` sets which Odoo top-level categories count as PC parts (default `CPU,GPU,DRAM,SSD,MB`).
- Known limit: cosmetic variants that shops don't tell apart (e.g. OC vs non-OC of one card) can carry the same shop prices.

## Odoo dependency

Needs two endpoints on **Luxtronic-Odoo-API**: `POST /inventory/products/price` (write the sales price) and `GET /inventory/products/:id/price` (read it, used by Revert's safety check). Deploy that first: `git pull && pm2 restart luxtronic-odoo-api` on the server.

## Deploy (internal LAN server)

Port **8006**, DB port **5437** (next free per the infra guidelines). The full checklist is in [docs/NOTES.md](docs/NOTES.md#deploy-checklist).

## Security

No login on the site: it must stay LAN-only (see the privacy guidelines). Only `/api/agent/*` needs the bearer key, and the server refuses it when `AGENT_API_KEY` is unset or still `change-me`. No customer data is stored; the database holds products, prices, suggestions and run logs.
