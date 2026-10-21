// Decides whether a search result is the same product as an Odoo product, builds the search
// text for it, and turns the matching rows into the per-shop prices a proposal needs.
// Pure functions - no network.
// Failing safe matters more than coverage here: a wrong match becomes a wrong market price
// in front of the approver, whereas a skipped product is just listed for a human to look at.

export const MAIN_SHOPS = [
  { key: 'centrecom', name: 'Centrecom', re: /centre ?com/i },
  { key: 'mwave', name: 'Mwave', re: /mwave/i },
  { key: 'scorptec', name: 'Scorptec', re: /scorptec/i },
  { key: 'pccasegear', name: 'PC Case Gear', re: /pc ?case ?gear/i },
];

export const MIN_SHOPS = 2; // a price from a single shop is not a market
const MAX_SPREAD = 1.6; // dearest shop / cheapest shop above this suggests a wrong match
const MAX_VS_CURRENT = 3; // market more than 3x (or under 1/3 of) the Odoo price is almost surely a wrong match
const MIN_DESCRIPTIVE_COVERAGE = 0.6; // share of a name's descriptive words a listing must also contain

// Words that distinguish products in the same family, so "5060" must not match "5060 Ti"
// and "B550M-A" must not match "B550M-A WiFi II".
const VARIANTS = new Set(['ti', 'super', 'xt', 'xtx', 'gre', 'white', 'black', 'plus', 'ultra', 'wifi', 'ii', 'ice', 'heatsink']);
// Not required in a match (shops word these differently) but they make the search far more precise.
const GPU_PREFIX = new Set(['rtx', 'gtx', 'rx', 'arc']);
const FORM_FACTORS = new Set(['2230', '2242', '2260', '2280', '22110']);
const SPEED_UNIT = /^\d+(mhz|ghz|mt|mts|mbs|gbs)$/; // 6000MHz vs 6000MT/s: shops disagree on the unit
// CAS latency, PCIe gen, sockets, VRAM type, wattage, pin count, ordinals ("2nd Gen"), "3D NAND", "x2":
// spec noise that shops leave out or word differently, so it can't be required or searched on.
const NOISE_TOKEN = /^(cl\d+|gen\d+|pcie\d*|am\d|lga\d+|gddr\d+x?|usb\d+|wifi\d+e?|\d+w|\d+pin|\d(st|nd|rd|th)|\dd|x\d|\d{1,2}g)$/;
const DDR = /^ddr\d$/;
// Words that say what kind of thing it is, not which one, plus brands (shops often drop them).
const GENERIC = new Set(['motherboard', 'mainboard', 'memory', 'module', 'ram', 'graphics', 'card', 'video', 'desktop', 'processor', 'cpu', 'gpu', 'ssd', 'solid', 'state', 'drive', 'nvme', 'pcie', 'pci', 'express', 'matx', 'atx', 'itx', 'eatx', 'micro', 'mini', 'socket', 'lga', 'with', 'and', 'the', 'for', 'series', 'unlocked', 'rgb', 'kit', 'core', 'cores', 'thread', 'threads', 'computer', 'sata', 'serial', 'nand', 'dimm', 'sodimm', 'udimm', 'gaming', 'edition', 'oc', 'radeon', 'geforce', 'nvidia', 'amd', 'intel', 'm', 'ghz', 'mhz', 'gb', 'tb', 'ddr', 'solid', 'short', 'version', 'gen']);

function normalise(text) {
  return String(text)
    .toLowerCase()
    .replace(/(\d)\s+(gb|tb)\b/g, '$1$2') // "1 TB" -> "1tb"
    .replace(/(\d+)\s*gb\s*x\s*(\d)\b/g, '$2x$1gb') // "16GB x2" -> "2x16gb"
    .replace(/\b(\d{1,2})\s*x\s*(\d+(?:gb|tb)\b)/g, '$1x$2') // "2 x 16GB" -> "2x16gb" (but never "9700X 8 Cores")
    .replace(/\b(lga|socket)\s*\d{3,4}\b/g, ' ') // "LGA 1700": a socket, not a model number
    .replace(/\b1x(\d+(?:gb|tb))\b/g, '$1') // a single "1 x 8GB" stick is just "8GB"
    .replace(/(ddr\d)[\s-]*\d{3,5}(?:\s?(?:mhz|mt\/?s))?(?![\w-]*pin)/g, '$1') // "DDR4-3200" / "DDR5 6000MHz": the speed varies by listing ("DDR4 288-pin" is a pin count, left alone)
    .replace(/\d{3,5}\s*\/\s*\d{3,5}(?:\s*mb\/?s)?/g, ' ') // "6600/3500 MB/s" read/write speeds
    .replace(/\bd([45])\b/g, 'ddr$1') // board suffix "D4" means DDR4
    .replace(/wi[\s-]?fi\s*(\d)(e?)\b/g, 'wifi$1$2') // "WiFi 7" -> "wifi7" (same as "WIFI7")
    .replace(/wi[\s-]?fi/g, 'wifi')
    // Board codes: "B650M-E" and "B650M-A" are different products. Keep the 1-3 character suffix attached
    // so it is part of the model token (but not "DDR5-6000", "Type-C" or "WIFI-CSM").
    .replace(/\b([a-z]*\d[a-z0-9]*)-([a-z0-9]{1,3})\b/g, '$1$2')
    .replace(/\b(rtx|gtx|rx|gt|arc)\s*(\d{3,4})/g, '$1 $2') // "RTX4060" and "RTX 4060" are the same card
    .replace(/\[[^\]]*\]/g, ' ') // [part numbers] in brackets
    .replace(/\((?=[a-z0-9-]*\d)(?=[a-z0-9-]*[a-z])[a-z0-9-]{8,}\)/g, ' ') // (part numbers) in parentheses, but not "(2x16gb)"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const tokens = (text) => normalise(text).split(' ').filter(Boolean);

// Memory speed and CAS latency change the product (and the price): if a listing and the product both
// say which, they must agree. Listings that leave them out are still accepted.
function memorySpeed(text) {
  const t = String(text).toLowerCase();
  const m = t.match(/\b(\d{4,5})\s*(?:mhz|mt\/?s)\b/) || t.match(/ddr\d[\s-]*(\d{4,5})\b/);
  return m ? Number(m[1]) : null;
}
const casLatency = (text) => { const m = String(text).toLowerCase().match(/\bcl\s?(\d{2})\b/); return m ? Number(m[1]) : null; };
const conflicts = (a, b) => a !== null && b !== null && a !== b;


// Manufacturer part codes (CT1000T500SSD8, MZ-V9P2T0BW, O32G): precise but shops often leave them out.
// A long token that keeps switching between letters and digits (v9p2t0bw: 6 switches) is a part number;
// a board code like b760mayw (3 switches) is not.
const switches = (tok) => (tok.match(/\d(?=[a-z])|[a-z](?=\d)/g) || []).length;
const isPartCode = (tok) => (tok.length >= 8 && switches(tok) >= 4) || /^o\d+g$/.test(tok);
const isCapacity = (tok) => /^\d+(gb|tb)$/.test(tok) || /^\d+x\d+(gb|tb)$/.test(tok);

// Tokens a candidate must contain: model numbers, capacities, and (for memory) the DDR generation.
function isRequired(tok, category) {
  if (SPEED_UNIT.test(tok) || NOISE_TOKEN.test(tok) || FORM_FACTORS.has(tok) || VARIANTS.has(tok) || isPartCode(tok)) return false;
  if (DDR.test(tok)) return category === 'DRAM';
  if (/^\d+x\d+(gb|tb)$/.test(tok)) return true; // kit layout, e.g. 2x16gb
  return /\d/.test(tok) && (/[a-z]/.test(tok) || tok.length >= 3);
}

export function productSignature(name, category = '') {
  const toks = tokens(name);
  const required = [...new Set(toks.filter((t) => isRequired(t, category)))];
  // Codenames in brackets ("(Arrow Lake)") and the colour tail after " - " are marketing: listings often drop them.
  const plain = String(name).replace(/\([^)]*\)/g, ' ').split(/\s+-\s+/)[0];
  const descriptive = [...new Set(tokens(plain).slice(1).filter((t) =>
    !GENERIC.has(t) && !VARIANTS.has(t) && !GPU_PREFIX.has(t) && !required.includes(t)
    && !isPartCode(t) && !NOISE_TOKEN.test(t) && !SPEED_UNIT.test(t) && !FORM_FACTORS.has(t)
    && !DDR.test(t) && !/^\d+$/.test(t) && t.length > 2))];
  return {
    brand: toks[0] || '',
    required,
    descriptive,
    variants: new Set(toks.filter((t) => VARIANTS.has(t))),
    formFactors: new Set(toks.filter((t) => FORM_FACTORS.has(t))),
    ddr: toks.find((t) => DDR.test(t)) || null,
    toks,
  };
}

// Search texts to try, most specific first. Shops' search ANDs every word, so an over-specific
// query returns nothing; later ones fall back to brand + model only, then to the bare part number.
export function buildQueries(productName, category = '') {
  const toks = tokens(productName);
  const brand = toks[0] || '';

  // Board codes keep the hyphen the shops write ("B760M-AYW"), not the glued token used for matching.
  const pieces = String(productName).replace(/\[[^\]]*\]/g, ' ').replace(/[(),]/g, ' ').split(/\s+/).filter(Boolean);
  const asWritten = new Map();
  for (const piece of pieces) {
    if (/^[a-z0-9]*\d[a-z0-9]*-[a-z0-9]{1,3}$/i.test(piece)) asWritten.set(normalise(piece), piece.toLowerCase());
  }

  const search = toks.slice(1).filter((t) => (isRequired(t, category) && !/^\d+x\d+(gb|tb)$/.test(t)) || VARIANTS.has(t) || GPU_PREFIX.has(t));
  const model = toks.slice(1).filter((t) => (isRequired(t, category) && !isCapacity(t) && !DDR.test(t)) || GPU_PREFIX.has(t));
  const say = (list) => [...new Set(list.map((t) => asWritten.get(t) || t))];

  // A long part number alone ("CT16G4SFRA32A", "MZ-V9P2T0BW") is the sharpest search when the name has nothing else.
  const bracketed = [...String(productName).matchAll(/[([]([A-Za-z0-9-]{8,})[)\]]/g)]
    .map((m) => m[1].toLowerCase())
    .filter((code) => /\d/.test(code) && /[a-z]/.test(code));
  const partNumbers = [...new Set([...bracketed, ...pieces
    .filter((piece) => /^[a-z0-9-]+$/i.test(piece) && tokens(piece).some((t) => t.length >= 8 && isPartCode(t)))
    .map((piece) => piece.toLowerCase())])];

  const queries = [[brand, ...say(search)].slice(0, 6), [brand, ...say(model)].slice(0, 4), partNumbers.slice(0, 1)]
    .map((words) => words.filter(Boolean).join(' '))
    .filter((q) => q && q !== brand); // a brand on its own matches half the shop
  return [...new Set(queries)];
}

export const buildQuery = (productName, category = '') => buildQueries(productName, category)[0] || '';

const COLOURS = new Set(['white', 'black']);
const squash = (text) => String(text).toLowerCase().replace(/[^a-z0-9]/g, '');

// Manufacturer part numbers in a product name: written in (brackets) or [brackets], or long letter/digit mixes.
function partNumbersOf(name) {
  const written = [...String(name).matchAll(/[([]([A-Za-z0-9-]{8,})[)\]]/g)].map((m) => squash(m[1]));
  const mixed = String(name).split(/\s+/).filter((piece) => tokens(piece).some((t) => t.length >= 8 && isPartCode(t))).map(squash);
  return [...new Set([...written, ...mixed])].filter((code) => code.length >= 8 && /\d/.test(code) && /[a-z]/.test(code));
}

export function matchesProduct(candidateName, productName, category = '') {
  const sig = productSignature(productName, category);
  if (!sig.required.length) return false; // nothing distinctive to hold a match to
  const candToks = tokens(candidateName);
  const cand = new Set(candToks);

  // Memory speed and CAS latency can't conflict however the listing is worded.
  if (conflicts(memorySpeed(productName), memorySpeed(candidateName))) return false;
  if (conflicts(casLatency(productName), casLatency(candidateName))) return false;

  // The listing quotes this product's own part number: that is the product, whatever else the title says.
  const squashed = squash(candidateName);
  if (partNumbersOf(productName).some((code) => squashed.includes(code))) return true;

  if (!sig.required.every((t) => cand.has(t))) return false;
  for (const v of VARIANTS) if (!COLOURS.has(v) && sig.variants.has(v) !== cand.has(v)) return false;
  // Colours: fine if the listing doesn't say; a conflict only if both name one, or the listing says White for a product that doesn't.
  const productColours = [...COLOURS].filter((c) => sig.variants.has(c));
  const candColours = [...COLOURS].filter((c) => cand.has(c));
  if (productColours.length && candColours.length && !productColours.some((c) => candColours.includes(c))) return false;
  if (!productColours.length && cand.has('white')) return false;

  const candFactors = [...FORM_FACTORS].filter((f) => cand.has(f));
  if (sig.formFactors.size && candFactors.length && !candFactors.some((f) => sig.formFactors.has(f))) return false;

  // Boards come in DDR4 and DDR5 versions of one name: if both sides say which, it must be the same.
  const candDdr = candToks.find((t) => DDR.test(t));
  if (sig.ddr && candDdr && sig.ddr !== candDdr) return false;

  // Same chipset, different board (B850 AORUS ELITE vs B850 AORUS PRO): most descriptive words must agree too.
  if (sig.descriptive.length >= 2) {
    const covered = sig.descriptive.filter((t) => cand.has(t)).length / sig.descriptive.length;
    if (covered < MIN_DESCRIPTIVE_COVERAGE) return false;
  }
  return true;
}

const shopOf = (store) => MAIN_SHOPS.find((s) => s.re.test(store));

// rows: lookup results. Returns { outcome: 'submit' | 'skip', reason, retailerPrices, notes }.
export function evaluate(product, rows) {
  const category = product.category_group || '';
  const matched = rows.filter((r) => !r.noise && shopOf(r.store) && matchesProduct(r.name, product.name, category));

  const perShop = new Map();
  for (const row of matched) {
    const shop = shopOf(row.store);
    const list = perShop.get(shop.key) || [];
    list.push(row);
    perShop.set(shop.key, list);
  }

  const retailerPrices = [];
  const unverified = [];
  for (const shop of MAIN_SHOPS) {
    const list = (perShop.get(shop.key) || []).sort((a, b) => a.price - b.price);
    if (!list.length) continue;
    const best = list.find((r) => r.inStock !== false) || list[0];
    retailerPrices.push({ retailer: shop.name, price: best.price, inStock: best.inStock !== false, url: best.url || undefined });
    if (best.inStock === null) unverified.push(shop.name);
  }

  if (retailerPrices.length < MIN_SHOPS) {
    return { outcome: 'skip', reason: `Only ${retailerPrices.length} of the main shops had a matching listing (need ${MIN_SHOPS})`, retailerPrices };
  }

  const prices = retailerPrices.map((r) => r.price);
  if (Math.max(...prices) / Math.min(...prices) > MAX_SPREAD) {
    return { outcome: 'skip', reason: 'Shop prices disagree by more than 60% - probably different products', retailerPrices };
  }

  const buyable = retailerPrices.filter((r) => r.inStock).map((r) => r.price);
  const market = buyable.length ? Math.min(...buyable) : Math.min(...prices);
  const current = Number(product.current_price);
  if (current > 0 && (market / current > MAX_VS_CURRENT || market / current < 1 / MAX_VS_CURRENT)) {
    return { outcome: 'skip', reason: `Market price ${market} is more than 3x away from the Odoo price ${current} - probably a wrong match`, retailerPrices };
  }

  const notes = unverified.length ? `Stock not confirmed for ${unverified.join(', ')} (price from StaticICE).` : '';
  return { outcome: 'submit', reason: '', retailerPrices, notes };
}
