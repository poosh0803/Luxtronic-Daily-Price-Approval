# CLAUDE.md

Guidance for Claude Code sessions in this repo. Read `README.md` for what the app does and `docs/NOTES.md` for why it is built this way.

## Before you change anything

- This is a Luxtronic in-house app. Follow `../LUXTRONIC-DESIGN-GUIDELINES.md`, `-API-CONVENTIONS.md`, `-DATABASE-CONVENTIONS.md`, `-INFRA-GUIDELINES.md` and `-PRIVACY-DATA-GUIDELINES.md` (they live one folder up, outside any repo). The port/DB registry in the infra guidelines already lists this project (8006 / 5437).
- Node ESM + Express, raw `pg` (one pool in `src/db.js`), plain HTML/CSS/JS, no build step, no framework.
- Responses are `{ success: true, ... }` / `{ success: false, message }`. Escape user/shop text with `escapeHtml()` before putting it in `innerHTML`.
- Page scripts are named after their page (`views/lookup.html` -> `public/js/lookup.js`). Theme tokens and dark mode follow the design guidelines (`body.dark-mode` overrides).

## Commands

```bash
npm install
npm start          # node app.js on PORT (8006)
npm test           # node --test; no database or network needed
docker compose -f docker/docker-compose.yml up -d   # dev Postgres on 5437
```

The dev `.env` is git-ignored; copy `.env.example`. `AGENT_API_KEY=change-me` disables the agent API on purpose.

## Where things are

- `src/matching.js` - the product matcher and search-word builder. Pure, heavily unit-tested (`test/matching.test.js`). Change it carefully: a wrong match becomes a wrong price in front of the approver, so **fail safe (skip) rather than guess**.
- `src/lookup.js` - price sources and the throttled shop-page checks. Pure parsers (`parseStaticIce`, `mapCentrecom`, `mapMwave`, `parseOffer`) are tested.
- `src/runner.js` / `src/scheduler.js` - pricing runs and the optional daily schedule. `runs` / `run_items` record every outcome.
- `src/routes/agent.js` - the key-protected "windows" for an agent. Keep it read-mostly: an agent suggests, only a person approving writes to Odoo.
- `src/odoo.js` - client for Luxtronic-Odoo-API (separate repo, port 4001).

## Rules that matter

- **Never write to Odoo except from `POST /api/proposals/:id/approve` and `/revert`.** Both push to Odoo first and only then update the database.
- **Don't try to get around a shop blocking us.** Scorptec answers HTTP 403 to Node requests; the code backs off for 30 minutes and uses StaticICE data. Keep requests slow (1 s per host) and cached.
- Only the fixed hosts in `src/lookup.js` may be contacted; never fetch a URL supplied by a caller.
- No secrets in git: `.env` is ignored; `.env.example` only has safe defaults. No customer data lives in this app.
- Schema changes: edit `docker/init-scripts/001_schema.sql` (not yet live anywhere) **and** apply an `ALTER` to existing dev databases. Once a production DB exists, write forward-only migration files instead.
- After editing a regex inside a shell one-liner, re-read the file: backslashes get lost. Prefer the Edit/Write tools for code.

## Testing

Pure logic is tested with node's built-in runner (`test/*.test.js`). Routes and the runner were checked by hand against a local database and a mock Odoo; there are no route tests yet. When you add matching rules, add a test with the real product name that motivated it.
