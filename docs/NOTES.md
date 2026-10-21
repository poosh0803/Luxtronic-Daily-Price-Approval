# Development notes

What was built, why it is built this way, what was learned, and what is left. Written 2026-10-17 at the end of the first build session.

## What it is

An internal site where price changes for PC parts (CPU, GPU, RAM, SSD, motherboards) are **suggested by code and approved by a person**. Odoo stays the source of truth: products and current prices come from it, and an approved price is written back to it.

```
Odoo  <->  Luxtronic-Odoo-API (port 4001)  <->  this app (8006)  <->  shops (StaticICE, Centrecom, Mwave, PC Case Gear, Scorptec)
                                                   |
                                                   +-- website (approve / revert / lookup)   LAN only, no login
                                                   +-- /api/agent/*                          Bearer key, for a Claude agent
```

## Decisions

| Decision | Why |
|---|---|
| Approving **writes back to Odoo** (via Luxtronic-Odoo-API) | The approver's choice. Odoo is pushed first; if it fails the suggestion stays pending, so the app and Odoo can't disagree |
| Markup = **dollars on top of market** (+0/+5/+10/+15) plus a Custom box | Typical for PC parts. Custom allows ±$1000 and must leave the price above $0 |
| **Market price = lowest in-stock shop price**, computed on the server | The agent/code only reports prices; the server does the arithmetic so it is the same every time |
| **Site has no login (LAN only); agent API needs a bearer key** | Matches the privacy guidelines. The server refuses the agent API when the key is unset or `change-me` |
| **Pricing is done by code, not an AI agent** | Cheaper, faster, repeatable. An agent only helps with what the rules can't judge (search words, "no listing" verdicts) |
| **Fail safe: skip, never guess** | A wrong match shows up as a plausible-looking wrong price. Skipped products are listed with the reason instead |
| Only **products with stock in Odoo** are priced | Nothing on hand means nothing to sell; cut a run from 213 to about 83 products |
| Approver can **pick any shop price as the base** | One shop sometimes has an unreasonably low price; the lowest-in-stock rule would then drag the suggestion down. The server only accepts a price that is on the suggestion, and records the shop used (`approved_base`, `approved_base_retailer`) |
| **Revert** checks Odoo's current price first | If someone changed the price in Odoo since, reverting would overwrite their change, so it refuses |

## Price sources: what was found

- **StaticICE** gives the spread across ~14 Australian shops in one request, but has **no stock information** and **doesn't list Mwave at all** (the old quotation page's "Mwave" filter never matched anything).
- **Centrecom** has a public search API (`computerparts.centrecom.com.au/api/search`) with price, sale price and stock; it needs browser-like `Origin`/`Referer` headers and returns 403 without them.
- **Mwave** runs on Shopify: `/search/suggest.json` returns price and availability.
- **PC Case Gear** product pages carry price and availability in schema.org markup (`itemprop`), fetchable from Node.
- **Scorptec** answers **HTTP 403 to Node's fetch whatever headers are sent**, while curl and a real browser get 200 (it looks like it blocks by connection fingerprint). This was deliberately **not worked around**: the lookup backs off for 30 minutes and keeps StaticICE's price for Scorptec, shown unverified.
- An older internal page proxies StaticICE requests; this app was written not to follow that pattern and only ever contacts the fixed hosts above.

## The matcher (`src/matching.js`) and how it got its rules

Each rule exists because a real product name broke without it:

- Spec noise out of searches and requirements: `65w`, `288-pin`, `6600/3500`, `white/rgb/cl28`, "2nd Gen", sockets (`LGA 1700`), VRAM type, part numbers. "amd 9600x 65w" found nothing; "amd 9600x" found everything.
- "9700X 8 Cores" was being glued into a fake model "9700x8" (kit-layout rule too greedy) and "LGA 1700" was read as a model number.
- **Board suffixes are part of the model:** B650M-**E** vs B650M-**A** matched each other, so one product would have carried another board's prices.
- **Variant words must agree both ways:** Ti, Super, XT, WiFi, II, ICE, Heatsink, Plus; "5060" must not match "5060 Ti".
- **Colours** conflict only when both sides name one (or a listing says White for a product that doesn't).
- **Memory speed and CAS latency** can't conflict (6000 vs 6400, CL28 vs CL30); DDR generation is required for memory but only a conflict check for boards (D4 = DDR4).
- **Descriptive words** (Aorus ELITE vs PRO) need 60% coverage; codenames in brackets and the colour tail after " - " are ignored.
- **Part numbers:** a listing that quotes the product's own part number matches outright; part numbers are never required (shops leave them out).
- **Power supplies:** wattage is the one spec that defines a PSU, so for PSUs `850W` is required (elsewhere wattage is noise); efficiency grades (Gold / Bronze / Platinum), `V2` and `SFX` must agree; "80+ Gold" and "ATX 3.1" wordings are normalised away. A real case: a cheaper Edge Gold **V2** (no hub) listing was being priced against the standard Edge Gold. `PSU / Cable` (cables, hubs) is excluded via `EXCLUDE_CATEGORIES`.
- Search ladder: the product's own **search words**, then brand + model + capacity, then brand + model, then the bare part number.

Acceptance: 2 of the 4 main shops, prices within 60% of each other, market within 3x of Odoo's price.

## Results so far (local dev data, 2026-10-17)

213 synced products, 83 with stock. After the rule fixes and four search words, a run prices **53**. Of the other 30, **18 aren't listed at any of the four shops** (discontinued Kingston / Samsung / Seagate / Team drives, some boards and memory) and were marked **No listing** (skipped until 2026-11-16); 12 are carried by only one shop.

Most suggestions look plausible; Odoo's prices are often out of date against the shops. Spot-check the biggest gaps before approving.

## Known limits

- Cosmetic variants that shops don't tell apart (OC vs non-OC) can carry identical shop prices.
- Scorptec rows are StaticICE-only (no stock, may lag).
- Mwave's advertised extra-5%-off coupon is not in its shelf price.
- Rules are tuned on ~83 products; a new product family may need a rule (and a test).
- No route/integration tests yet; the runner and routes were verified by hand against a dev database and a mock Odoo.
- Search words, No listing and the clean-up are intended as on-request jobs for a person or agent, not automatic.

## Deploy checklist

Nothing here is deployed yet.

1. **Luxtronic-Odoo-API first:** it gained `POST /inventory/products/price` and `GET /inventory/products/:id/price`. On the server: `git pull && pm2 restart luxtronic-odoo-api`. Until then, approving fails with a 404 (the suggestion stays pending).
2. **Database:** create `luxtronic_price_approval_db` on the database host, port `5437` (one Postgres per app, next free port per the infra guidelines) from `docker/init-scripts/001_schema.sql`.
3. **Server clone + `.env`:** real `DB_*`, `ODOO_API_URL=http://localhost:4001`, a generated `AGENT_API_KEY`, optional `AUTO_RUN_HOUR`.
4. **Run:** `npm install` then `pm2 start ecosystem.config.cjs` (process `luxtronic-price-approval`).
5. **Register it:** add the process to the `lan-portal-deploy` skill's service list and the new database to `luxtronic-db-backup`'s targets. Keep the site LAN-only.
6. **Check first:** approve one real product and confirm the price in Odoo; try Revert on it.

## Outside this repo

- `../LUXTRONIC-INFRA-GUIDELINES.md` (not in any git repo) now lists port 8006 / DB 5437 for this app and names 8007 / 5438 as the next free ones.
- `Luxtronic-Odoo-API` was changed (two endpoints, README). Its `.gitignore` also had an unrelated local change and an untracked `backups/` folder, which were left alone.

## Ideas, not built

- Route tests with a mock Odoo and a test database.
- A monthly agent clean-up pass (routine in `AGENT.md`), or a scheduled task for it.
- Running 2-3 products at once in a run (about 2x faster; would raise the load on StaticICE).
- A history of approved price changes per product, and an export.
