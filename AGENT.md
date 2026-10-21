# Agent Guide

Pricing is done by code, not by the agent. A **pricing run** syncs PC parts from Odoo, looks up each one (StaticICE, plus Centrecom, Mwave, Scorptec and PC Case Gear directly), keeps only listings that are clearly the same product, and creates pending suggestions for a human to approve. See `src/runner.js` and `src/matching.js`.

The agent's job is to **look inside the system and help where the code could not** - never to change a price. Only a person approving on the website writes to Odoo.

Base URL: `http://<app-server>:8006` (internal network only). Every call sends `Authorization: Bearer <AGENT_API_KEY>`.

## Windows into the system (read-only)

| Call | What it shows |
|---|---|
| `GET /api/agent/status` | Tracked product count, pending suggestions, approvals in the last 7 days, whether a run is going, the latest run, and `unpriced` (products the latest run could not price, with reasons) |
| `GET /api/agent/proposals?status=pending\|history\|all` | Suggestions with retailer prices, market price, notes, and (history) the approved markup and price |
| `GET /api/agent/runs` / `GET /api/agent/runs/:id?outcome=skipped,failed,submitted` | Run history and every product a run looked at, with the search used, the prices the matcher found, and why it skipped |
| `GET /api/agent/products[?sync=1]` | Tracked Odoo PC parts (`sync=1` refreshes from Odoo first) |
| `GET /api/agent/lookup?q=<model>&pages=1-3&verify=0` | Live market prices for any search. Rows carry `store`, `price`, `wasPrice`, `inStock` (true / false / null = unknown), `verified` (read from the shop itself), `noise` (bundle / used) |

## Actions

- `POST /api/agent/runs` with optional `{ "limit": 10, "group": "GPU", "sync": false, "includeZeroStock": false }` starts the same run as the **Run pricing now** button (one at a time; `409` if one is running). Products with 0 stock in Odoo are skipped by default - nothing on hand, nothing to price. Returns `202` and a `runId` - poll `/api/agent/runs/:id` or `/status`.
- `POST /api/agent/proposals` submits a suggestion yourself, e.g. for a product the run skipped:

```json
{ "proposals": [ {
  "productId": 12,
  "retailerPrices": [
    { "retailer": "Scorptec",  "price": 389.00, "inStock": true,  "url": "https://..." },
    { "retailer": "Centrecom", "price": 379.00, "inStock": false, "url": "https://..." }
  ],
  "notes": "Matched by part number CT1000P310SSD8; Mwave lists it as a bundle"
} ] }
```

Identify the product with `productId` (preferred), `odooId` or `sku`. The server picks the market price (lowest in-stock) itself, and a new suggestion replaces the product's earlier pending one.

- `PUT /api/agent/products/:id/search-hint` with `{ "query": "amd 9600x" }` sets the search words the next run tries first for that product (`null` clears them). They persist, so this is a one-off fix per product, not a daily chore. `GET /api/agent/products` returns each product's current `search_hint`.

- `PUT /api/agent/products/:id/no-listing` with `{ "days": 30, "note": "checked all four shops" }` records that the shops don't carry a product, so pricing runs skip it until the mark expires (default 30 days, max 365). `{ "clear": true }` puts it back in the next run. Marked products show a grey **No listing** badge on the Products page and leave the Couldn't price list.

## Clean-up pass (on request, e.g. after a sync adds products, or monthly)

1. `GET /api/agent/status` -> `unpriced` is the Couldn't price list.
2. For each product, test a few searches with `GET /api/agent/lookup` (brand + model number; try without the capacity or colour; try the bare part number). Look at which rows really are that exact product.
3. **Listed at 2+ main shops, but the run missed it** -> save the working search with `PUT .../search-hint`.
4. **Not listed at any of the four main shops** (discontinued, or never stocked) -> `PUT .../no-listing` with a note saying what you checked. This is the main time saver: those products stop being looked up on every run.
5. **Listed at only one main shop** -> leave it as it is; one shop isn't a market price. Mark it no-listing only if you are sure the others don't carry it.
6. Report what you changed, and anything you were unsure about, so the person can check.

## How to help with skipped products

1. `GET /api/agent/status` -> look at `unpriced`. Typical reasons: fewer than 2 main shops had a matching listing (often a discontinued card or an unusual name), shop prices disagreed by more than 60% (likely a wrong match), or the market price was more than 3x away from Odoo's (likely a wrong match).
2. Try `GET /api/agent/lookup` with a better search (shorter is usually better: brand + model number, e.g. `amd 9600x`; drop wattage, pin counts, speeds and marketing words) (the model number alone, or the part number) and judge by eye which rows really are that product, including variant words (Ti, Super, White, WiFi, OC, kit size).
3. When a search works, save it with `PUT /api/agent/products/:id/search-hint` so the next run finds the product by itself. The matcher still checks that results really are that product, so a good hint will not let a wrong listing through. If the listings are named so differently that the matcher still rejects them, submit the prices yourself instead:
4. Submit only prices you are confident belong to *that exact product*, with `notes` saying how you matched it. If you are not sure, leave it for the human.

## Rules

- Never guess a price. If a shop's stock is `null`, pass `"inStock": true` only if you checked, otherwise say in `notes` that stock is unconfirmed.
- Scorptec currently blocks direct page checks from the server, so its rows are StaticICE-only (`verified: false`). That is expected; do not try to work around it.
- Ignore bundles, open-box, refurbished and pre-order rows.
- Be gentle: the lookup is cached for 10 minutes and spaces its requests, so repeated calls are cheap, but don't loop over hundreds of products yourself - start a run instead.

## Response codes

`200`/`201`/`202` ok - `400` bad body - `401` bad key - `404` not found - `409` a run is already in progress - `503` server has no `AGENT_API_KEY` set.
