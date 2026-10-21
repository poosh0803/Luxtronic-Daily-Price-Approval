// Market price lookup: StaticICE (price comparison across AU shops) plus Centrecom's and
// Mwave's own search APIs (StaticICE has no stock info, and no longer lists Mwave at all).
// Only these fixed hosts are ever contacted - the caller supplies a search term, never a URL.
import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const STATICICE = 'https://www.staticice.com.au/cgi-bin/search.cgi';
const CENTRECOM_API = 'https://computerparts.centrecom.com.au/api/search';
const MWAVE = 'https://www.mwave.com.au';
const CENTRECOM_CID = '0ae1fd6a074947699fbe46df65ee5714'; // public id used by Centrecom's own site search

const PAGE_SIZE = 20;
const MAX_PAGES = 3;
const PAGE_DELAY_MS = 500;
const CACHE_TTL_MS = 10 * 60 * 1000;

// Names that suggest the row is not the plain retail part.
const NOISE = /\b(bundle|gaming pc|desktop pc|damaged|open box|refurb(ished)?|pre-?built|combo|used|second ?hand|ex-?demo|delidded)\b/i;

const cache = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  return res;
}

// StaticICE links go through its redirect.cgi; the real shop URL is in `newurl`.
function realUrl(href) {
  try {
    const target = new URL(href, 'https://www.staticice.com.au').searchParams.get('newurl');
    return /^https?:\/\//i.test(target || '') ? target : null;
  } catch {
    return null;
  }
}

export function parseStaticIce(html) {
  const $ = cheerio.load(html);
  const rows = [];
  $('tr[valign="top"]').each((_, tr) => {
    const cells = $(tr).children('td');
    if (cells.length !== 2) return;

    const priceLink = cells.eq(0).find('a').first();
    const price = parseFloat(priceLink.text().replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(price) || price <= 0) return;

    const desc = cells.eq(1);
    const name = desc.contents().first().text().trim();
    const storeLink = desc.find('a[title^="Click to visit"]').first();
    const store = storeLink.find('b').text().trim() || storeLink.text().trim();
    if (!name || !store) return;

    const meta = desc.text();
    rows.push({
      store,
      location: (meta.match(/\(([A-Z]{2,3})\)/) || [])[1] || '',
      name,
      price,
      wasPrice: null,
      availability: 'Unknown',
      inStock: null, // StaticICE does not say
      updated: (meta.match(/updated:\s*(\d{2}-\d{2}-\d{4})/) || [])[1] || null,
      url: realUrl(priceLink.attr('href')),
      source: 'StaticICE',
    });
  });
  return rows;
}

export function mapCentrecom(json) {
  const products = Array.isArray(json?.p) ? json.p : [];
  return products
    .filter((p) => p.price > 0 && !p.callForPrice)
    .map((p) => {
      const label = String(p.stockAvailablity || '').trim();
      return {
        store: 'Centrecom',
        location: '',
        name: p.name,
        price: Number(p.price),
        wasPrice: p.wasPrice > 0 ? Number(p.wasPrice) : null,
        availability: label || 'Unknown',
        // "INSTORE ONLY" can still be bought at a branch, so it counts; pre-order and out of stock don't.
        inStock: /^(in ?stock|instore only)/i.test(label) || p.stockQuantity > 0,
        updated: null,
        url: p.seName ? `https://www.centrecom.com.au/${p.seName}` : null,
        source: 'Centrecom',
      };
    });
}

// The shops' own search is fuzzy (it returns 7800X3D for a 9800X3D search), so keep only
// rows whose name contains every word of the query.
export function matchesQuery(name, query) {
  const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const haystack = ` ${norm(name)} `;
  return norm(query).split(' ').filter(Boolean).every((tok) => haystack.includes(tok));
}

// Mwave runs on Shopify; its public suggest endpoint returns price and availability.
export function mapMwave(json) {
  const products = json?.resources?.results?.products;
  return (Array.isArray(products) ? products : [])
    .filter((p) => Number(p.price) > 0)
    .map((p) => {
      const compare = Number(p.compare_at_price_max);
      return {
        store: 'Mwave',
        location: '',
        name: p.title,
        price: Number(p.price),
        wasPrice: compare > Number(p.price) ? compare : null,
        availability: p.available ? 'In stock' : 'Out of stock',
        inStock: Boolean(p.available),
        updated: null,
        url: p.url ? MWAVE + String(p.url).split('?')[0] : null,
        source: 'Mwave',
      };
    });
}

async function fetchMwave(query) {
  const url = `${MWAVE}/search/suggest.json?q=${encodeURIComponent(query)}&resources%5Btype%5D=product&resources%5Blimit%5D=10`;
  return mapMwave(await (await get(url)).json());
}

async function fetchStaticIce(query, pages) {
  const all = [];
  for (let page = 0; page < pages; page++) {
    const url = `${STATICICE}?q=${encodeURIComponent(query)}&start=${page * PAGE_SIZE + 1}&links=${PAGE_SIZE}&showadres=1&pos=1`;
    const rows = parseStaticIce(await (await get(url)).text());
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break; // last page
    if (page < pages - 1) await sleep(PAGE_DELAY_MS);
  }
  return all;
}

async function fetchCentrecom(query) {
  const url = `${CENTRECOM_API}?cid=${CENTRECOM_CID}&q=${encodeURIComponent(query)}`;
  const res = await get(url, { Origin: 'https://www.centrecom.com.au', Referer: 'https://www.centrecom.com.au/' });
  return mapCentrecom(await res.json());
}

// ---- Direct verification of Scorptec / PC Case Gear -------------------------------------
// StaticICE has no stock info and can lag, so the cheapest rows for these two shops are
// re-read from the shop's own product page. Requests are spaced per host and only ever
// go to the hosts below, and only to URLs StaticICE gave us.
const VERIFY_SHOPS = [
  { name: 'Scorptec', storeRe: /scorptec/i, hostRe: /(^|\.)scorptec\.com\.au$/i },
  { name: 'PC Case Gear', storeRe: /pc ?case ?gear/i, hostRe: /(^|\.)pccasegear\.com$/i },
];
const VERIFY_PER_SHOP = 2; // try the cheapest row, then the next if it turns out to be out of stock
const HOST_GAP_MS = 1000;
const RETRY_WAIT_MS = 3000;
const VERIFY_TTL_MS = 30 * 60 * 1000;
const BLOCK_COOLDOWN_MS = 30 * 60 * 1000;
const blockedHosts = new Map(); // host -> time until which we skip it after an HTTP 403

const hostQueues = new Map(); // host -> promise chain, so requests to one shop never overlap
const verifyCache = new Map(); // url -> { at, offer }

function throttled(host, task) {
  const run = (hostQueues.get(host) || Promise.resolve()).then(task);
  hostQueues.set(host, run.catch(() => {}).then(() => sleep(HOST_GAP_MS)));
  return run;
}

// Reads price + availability from a product page: JSON-LD Product first, then schema.org microdata.
// "1,299" -> 1299 (parseFloat would stop at the comma and return 1).
const toPrice = (v) => Number(String(v ?? '').replace(/[$,\s]/g, ''));

export function parseOffer(html) {
  const $ = cheerio.load(html);
  let price = null;
  let availability = '';

  $('script[type="application/ld+json"]').each((_, el) => {
    if (price !== null) return;
    try {
      const nodes = [].concat(JSON.parse($(el).contents().text()));
      for (const node of nodes) {
        if (!/product/i.test([].concat(node['@type'] || []).join(','))) continue;
        const offer = [].concat(node.offers || [])[0];
        if (!offer) continue;
        price = toPrice(offer.price ?? offer.lowPrice);
        availability = String(offer.availability || '');
        return;
      }
    } catch { /* not valid JSON-LD, try the next block */ }
  });

  if (!Number.isFinite(price)) {
    const box = $('[itemprop="offers"]').first();
    price = toPrice(box.find('[itemprop="price"]').attr('content'));
    availability = box.find('[itemprop="availability"]').attr('content') || '';
  }
  if (!Number.isFinite(price) || price <= 0) return null;

  const status = availability.split('/').pop() || '';
  return {
    price,
    inStock: /^InStock$/i.test(status) || (status === '' ? null : /^LimitedAvailability$/i.test(status)),
    availability: status.replace(/([a-z])([A-Z])/g, '$1 $2') || 'Unknown',
  };
}

async function fetchOffer(url, host) {
  const hit = verifyCache.get(url);
  if (hit && Date.now() - hit.at < VERIFY_TTL_MS) return hit.offer;

  // A shop that has refused us is left alone for a while rather than hammered.
  const blockedUntil = blockedHosts.get(host);
  if (blockedUntil && Date.now() < blockedUntil) throw new Error('shop is blocking automated requests, skipped for now');

  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const html = await throttled(host, async () => (await get(url, { Accept: 'text/html' })).text());
      const offer = parseOffer(html);
      if (!offer) throw new Error('no price found on page');
      verifyCache.set(url, { at: Date.now(), offer });
      return offer;
    } catch (error) {
      lastError = error;
      if (/HTTP 403/.test(error.message)) {
        // A deliberate block, not a blip: don't retry and don't try to get around it.
        blockedHosts.set(host, Date.now() + BLOCK_COOLDOWN_MS);
        break;
      }
      if (!/HTTP (429|5\d\d)/.test(error.message)) break; // only rate limits / server errors are worth one retry
      await sleep(RETRY_WAIT_MS);
    }
  }
  throw lastError;
}

// Mutates rows in place; returns warnings for shops that could not be checked.
async function verifyShops(rows) {
  const warnings = [];
  await Promise.all(VERIFY_SHOPS.map(async (shop) => {
    const candidates = rows
      .filter((r) => r.source === 'StaticICE' && shop.storeRe.test(r.store) && !r.noise && r.url)
      .sort((a, b) => a.price - b.price)
      .slice(0, VERIFY_PER_SHOP);

    for (const row of candidates) {
      let host;
      try { host = new URL(row.url).hostname; } catch { continue; }
      if (!shop.hostRe.test(host)) continue; // e.g. an affiliate redirect - never fetch it

      try {
        const offer = await fetchOffer(row.url, host);
        Object.assign(row, {
          price: offer.price,
          inStock: offer.inStock,
          availability: offer.availability,
          verified: true,
          updated: null,
          source: `${shop.name} (checked)`,
        });
        if (offer.inStock !== false) break; // found a buyable one, no need to check dearer rows
      } catch (error) {
        warnings.push(`${shop.name}: could not check the shop page (${error.message}) - showing StaticICE price`);
        break;
      }
    }
  }));
  return warnings;
}

// Returns { query, results, warnings }. A source failing does not fail the lookup.
// options.verify (default true): re-check Scorptec / PC Case Gear on their own sites.
export async function lookupPrices(query, pages = 2, { verify = true } = {}) {
  const q = String(query || '').trim().slice(0, 120);
  if (!q) throw new Error('q is required');
  const nPages = Math.min(Math.max(parseInt(pages, 10) || 2, 1), MAX_PAGES);

  const key = `${q.toLowerCase()}|${nPages}|${verify ? 'v' : 'n'}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value, cached: true };

  const warnings = [];
  const [staticice, centrecomRaw, mwaveRaw] = await Promise.all([
    fetchStaticIce(q, nPages).catch((e) => { warnings.push(`StaticICE: ${e.message}`); return []; }),
    fetchCentrecom(q).catch((e) => { warnings.push(`Centrecom: ${e.message}`); return []; }),
    fetchMwave(q).catch((e) => { warnings.push(`Mwave: ${e.message}`); return []; }),
  ]);
  const centrecom = centrecomRaw.filter((r) => matchesQuery(r.name, q));
  const mwave = mwaveRaw.filter((r) => matchesQuery(r.name, q));

  // The shops' own feeds are live and have stock, so they replace StaticICE's rows for those shops.
  const worked = (shop) => !warnings.some((w) => w.startsWith(shop));
  const dropped = (r) => (worked('Centrecom') && /centre ?com/i.test(r.store)) || (worked('Mwave') && /mwave/i.test(r.store));
  const merged = [...staticice.filter((r) => !dropped(r)), ...centrecom, ...mwave]
    .map((r) => ({ ...r, noise: NOISE.test(r.name), verified: r.source !== 'StaticICE' }));

  if (verify) warnings.push(...await verifyShops(merged));
  merged.sort((a, b) => a.price - b.price);

  if (!merged.length && warnings.length) throw new Error(warnings.join('; '));
  const value = { query: q, results: merged, warnings };
  cache.set(key, { at: Date.now(), value });
  return { ...value, cached: false };
}
