import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, buildQueries, matchesProduct, evaluate, productSignature } from '../src/matching.js';

test('buildQuery keeps brand and distinctive tokens only', () => {
  assert.deepEqual(buildQueries('AMD Ryzen 7 9800X3D 8 Core AM5 CPU'), ['amd ryzen 9800x3d', 'amd 9800x3d']);
  assert.deepEqual(buildQueries('ASUS Dual GeForce RTX 5060 Ti 16GB OC GDDR7 Graphics Card'), ['asus dual rtx 5060 ti 16gb', 'asus rtx 5060 ti 16gb', 'asus rtx 5060']);
});

test('model numbers must all be present', () => {
  const p = 'AMD Ryzen 7 9800X3D 8 Core AM5 CPU';
  assert.equal(matchesProduct('AMD Ryzen 7 9800X3D Desktop Processor', p), true);
  assert.equal(matchesProduct('AMD Ryzen 7 7800X3D Desktop Processor', p), false);
});

test('variant words must agree both ways', () => {
  const base = 'ASUS Dual GeForce RTX 5060 8GB OC GDDR7';
  const ti = 'ASUS Dual GeForce RTX 5060 Ti 16GB OC GDDR7';
  assert.equal(matchesProduct('ASUS Dual RTX 5060 8GB OC Video Card', base), true);
  assert.equal(matchesProduct('ASUS Dual RTX 5060 Ti 8GB OC Video Card', base), false);
  assert.equal(matchesProduct('ASUS Dual RTX 5060 16GB Video Card', ti), false);
  assert.equal(matchesProduct('ASUS Dual RTX 5060 Ti 16GB Video Card', ti), true);
});

test('capacity and kit layout are normalised', () => {
  const p = 'Crucial P310 1TB Gen4 2280 NVMe SSD';
  assert.equal(matchesProduct('Crucial P310 1 TB PCIe Gen4 NVMe SSD', p), true); // shop omits form factor
  assert.equal(matchesProduct('Crucial P310 1TB 2230 NVMe SSD', p), false); // different form factor
  assert.equal(matchesProduct('Crucial P310 2TB 2280 NVMe SSD', p), false);
  assert.equal(matchesProduct('Corsair Vengeance DDR5 32GB (2 x 16GB) 6000MT/s', 'Corsair Vengeance DDR5 6000MHz 32GB(2x16GB)'), true);
});

const row = (store, price, inStock, name = 'AMD Ryzen 7 9800X3D Desktop Processor') => ({ store, price, inStock, name, noise: false, url: `https://x/${store}` });
const product = { name: 'AMD Ryzen 7 9800X3D 8 Core AM5 CPU', current_price: 759 };

test('evaluate picks the cheapest in-stock row per shop', () => {
  const r = evaluate(product, [row('Centrecom', 599, true), row('Mwave', 648, true), row('Scorptec', 679, null), row('PC Case Gear', 640, false), row('PC Case Gear', 679, true), row('JW Computers', 500, null)]);
  assert.equal(r.outcome, 'submit');
  assert.deepEqual(r.retailerPrices.map((x) => [x.retailer, x.price, x.inStock]), [['Centrecom', 599, true], ['Mwave', 648, true], ['Scorptec', 679, true], ['PC Case Gear', 679, true]]);
  assert.match(r.notes, /Scorptec/);
});

test('evaluate skips when matching listings are too few, too spread, or far from Odoo', () => {
  assert.equal(evaluate(product, [row('Centrecom', 599, true)]).outcome, 'skip');
  assert.equal(evaluate(product, [row('Centrecom', 300, true), row('Mwave', 700, true)]).outcome, 'skip');
  assert.equal(evaluate({ ...product, current_price: 100 }, [row('Centrecom', 599, true), row('Mwave', 610, true)]).outcome, 'skip');
});

test('bundles flagged as noise are ignored', () => {
  const bundle = { ...row('Mwave', 650, true), noise: true };
  assert.equal(evaluate(product, [row('Centrecom', 599, true), bundle]).outcome, 'skip');
});

test('graphics card prefix spacing does not matter', () => {
  assert.equal(matchesProduct('ASUS Dual GeForce RTX 4060 EVO OC 8GB GDDR6', 'ASUS DUAL GeForce RTX4060 OC 8GB EVO GDDR6'), true);
  assert.deepEqual(buildQueries('ASUS DUAL GeForce RTX4060 OC 8GB EVO GDDR6'), ['asus dual evo rtx 4060 8gb', 'asus rtx 4060 8gb', 'asus rtx 4060']);
});

test('board model suffixes and WiFi variants are different products', () => {
  const tuf = 'ASUS B650M-E WIFI TUF GAMING MOTHERBOARD AM5';
  assert.equal(matchesProduct('ASUS TUF GAMING B650M-E WIFI AM5 mATX Motherboard', tuf), true);
  assert.equal(matchesProduct('ASUS PRIME B650M-A WIFI AM5 mATX Motherboard', tuf), false);
  const k = 'ASUS Prime B550M-K ARGB AM4 Micro ATX Desktop Motherboard';
  assert.equal(matchesProduct('ASUS PRIME B550M-A WIFI II AM4 Motherboard', k), false);
  const aWifi = 'Asus Prime B550M-A WiFi II AM4 mATX Desktop Motherboard';
  assert.equal(matchesProduct('ASUS PRIME B550M-A AM4 Motherboard', aWifi), false); // no WiFi
  assert.equal(matchesProduct('ASUS Prime B550M-A Wi-Fi II AM4 mATX', aWifi), true);
  assert.equal(matchesProduct('ASUS PRIME B760M-A WIFI LGA1700', 'ASUS B760M-AYW WIFI LGA1700 Motherboard'), false);
});

test('hyphens in memory speeds are not glued into the model', () => {
  assert.equal(matchesProduct('Corsair Vengeance DDR5-6000 32GB (2x16GB)', 'Corsair Vengeance DDR5 6000MHz 32GB(2x16GB)'), true);
});

test('search text keeps model codes as the shops write them', () => {
  assert.equal(buildQuery('ASUS B760M-AYW WIFI LGA1700 Motherboard'), 'asus b760m-ayw wifi');
  assert.deepEqual(buildQueries('Corsair Vengeance DDR5 6000MHz 32GB(2x16GB)', 'DRAM'), ['corsair vengeance ddr5 32gb', 'corsair ddr5 32gb']);
});

test('spec noise is dropped from the search text', () => {
  assert.deepEqual(buildQueries('AMD Ryzen 5 9600X AM5 6-Core 3.9 GHz Socket AM5 65W Radeon Graphics Processor', 'CPU'), ['amd ryzen 9600x', 'amd 9600x']);
  assert.deepEqual(buildQueries('Crucial P310 500GB Gen4 2280 NVMe SSD 6600/3500 MB', 'SSD'), ['crucial p310 500gb', 'crucial p310']);
  assert.deepEqual(buildQueries('ADATA Premier Memory Module 8 GB 1 X 8 GB DDR4 288-pin DIMM', 'DRAM'), ['adata premier 8gb ddr4', 'adata 8gb ddr4']);
});

test('a bare part number is the last-resort search, never just the brand', () => {
  assert.deepEqual(buildQueries('Crucial 16GB DDR4-3200 SODIMM (CT16G4SFRA32A)', 'DRAM'), ['crucial 16gb ddr4', 'ct16g4sfra32a']);
});

test('part codes and speeds are not required, DDR only matters for memory', () => {
  assert.equal(matchesProduct('Samsung 990 PRO 2TB NVMe M.2 SSD', 'Samsung 990 PRO 2TB M.2 2280 NVMe PCIe 4.0 SSD (MZ-V9P2T0BW)', 'SSD'), true);
  assert.equal(matchesProduct('MSI PRO B760M-A WIFI mATX Motherboard', 'MSI PRO B760M-A WIFI DDR5 LGA1700 mATX Motherboard', 'MB'), true);
  assert.equal(matchesProduct('MSI PRO B760M-A WIFI DDR4 mATX Motherboard', 'MSI PRO B760M-A WIFI DDR5 LGA1700 mATX Motherboard', 'MB'), false); // both name a different DDR
  assert.equal(matchesProduct('Kingston 16GB DDR4 3200 SODIMM', 'Kingston 16GB DDR5 SODIMM', 'DRAM'), false);
  assert.equal(matchesProduct('Crucial 8GB DDR4-3200 UDIMM', 'Crucial CT8G4DFRA32A Memory Module 8 GB 1 X 8 GB DDR4 3200 MHz UDIMM', 'DRAM'), true);
});

test('same chipset but a different board name does not match', () => {
  const elite = 'Gigabyte B850 AORUS ELITE WIFI7 ICE AM5 DDR5 ATX Motherboard';
  assert.equal(matchesProduct('Gigabyte B850 AORUS PRO ICE WIFI7 AM5 ATX Motherboard', elite, 'MB'), false);
  assert.equal(matchesProduct('Gigabyte B850 AORUS ELITE WIFI7 ICE AM5 ATX Motherboard', elite, 'MB'), true);
});

test('"9700X 8 Cores" is not a kit layout and sockets are not models', () => {
  assert.deepEqual(buildQueries('AMD Ryzen 7 9700X 8 Cores 16 Threads 5.5GHz AM5 CPU', 'CPU'), ['amd ryzen 9700x', 'amd 9700x']);
  assert.deepEqual(buildQueries('Intel Core I5-14400F LGA 1700 CPU', 'CPU'), ['intel i5 14400f']);
  assert.equal(matchesProduct('Intel Core i5-14400F Desktop Processor', 'Intel Core I5-14400F LGA 1700 CPU', 'CPU'), true);
  assert.equal(matchesProduct('Corsair Vengeance 32GB (2 x 16GB) DDR5', 'Corsair 32GB (2x16GB) DDR5 6000MHz', 'DRAM'), true);
});

test('memory speed and CAS latency must not conflict', () => {
  const p = 'Klevv CRAS V RGB 32GB (2 x 16GB) DDR5 6000MHz CL28 Desktop RAM - Obsidian Black';
  assert.equal(matchesProduct('KLEVV CRAS V RGB 32GB (2x16GB) 6000MHz CL28 DDR5 Black', p, 'DRAM'), true);
  assert.equal(matchesProduct('KLEVV CRAS V RGB 32GB (2x16GB) 6000MHz CL30 DDR5 Black', p, 'DRAM'), false);
  assert.equal(matchesProduct('KLEVV CRAS V RGB 32GB (2x16GB) 6400MHz CL28 DDR5 Black', p, 'DRAM'), false);
  assert.equal(matchesProduct('Klevv CRAS V RGB 32GB (2 x 16GB) DDR5 6000MT/s Black', p, 'DRAM'), true); // CL omitted
});

test('"WiFi 7" and "WIFI7" are the same, and colour only conflicts when both say one', () => {
  const p = 'Gigabyte B850 AORUS ELITE WIFI7 ICE AM5 DDR5 ATX Motherboard';
  assert.equal(matchesProduct('Gigabyte B850 Aorus Elite WiFi 7 Ice DDR5 Motherboard [B850-A-ELITE-WF7-ICE]', p, 'MB'), true);
  const kit = 'Klevv CRAS V RGB 32GB (2 x 16GB) DDR5 6000MHz CL30 Desktop RAM - Obsidian Black';
  assert.equal(matchesProduct('KLEVV CRAS V RGB 32GB (2x 16GB) DDR5 6000MHz CL30 Desktop Memory', kit, 'DRAM'), true); // no colour stated
  assert.equal(matchesProduct('Klevv CRAS V RGB 32GB (2x16GB) 6000MHz CL30 DDR5 White', kit, 'DRAM'), false);
  assert.equal(matchesProduct('Klevv CRAS V RGB 32GB (2x16GB) 6000MHz CL30 DDR5 Black', kit, 'DRAM'), true);
});

test("a listing quoting the product's own part number matches", () => {
  const p = 'KLEVV FIT V 32GB (16GB x2) 6000Mhz CL30 DDR5 RAM MODULE (KD5AGU880-60A300F)';
  assert.equal(matchesProduct('Klevv Fit V 32GB (2x16GB) 6000MHz CL30 DDR5 White [KD5AGU880-60A300F]', p, 'DRAM'), true);
  assert.equal(matchesProduct('Klevv Fit V 32GB (2x16GB) 6400MHz CL32 DDR5 White [KD5AGU880-64A320F]', p, 'DRAM'), false);
});

test('power supplies: wattage and efficiency grade must agree', () => {
  const p = 'Lian Li Edge Gold 850W 80+ Gold Modular ATX 3.1 Power Supply - White';
  assert.equal(matchesProduct('Lian Li EDGE 850W 80 PLUS Gold ATX 3.1 Fully Modular PSU White', p, 'PSU'), true);
  assert.equal(matchesProduct('Lian Li EDGE 1000W 80 PLUS Gold ATX 3.1 Fully Modular PSU White', p, 'PSU'), false); // other wattage
  assert.equal(matchesProduct('Lian Li EDGE 850W 80 PLUS Platinum ATX 3.1 Modular PSU White', p, 'PSU'), false); // other grade
  assert.equal(matchesProduct('Lian Li EDGE 850W 80 PLUS Gold ATX 3.1 Modular PSU Black', p, 'PSU'), false); // other colour
});

test('a bare wattage that repeats the wattage token is not a second requirement', () => {
  const p = 'FSP VITA 850 GM FULL-MODULAR PSU 850 W ATX3.1 PCIe 5.1';
  assert.deepEqual(productSignature(p, 'PSU').required, ['850w']);
  assert.equal(matchesProduct('FSP Vita GM 850W 80+ Gold Fully Modular ATX 3.1 PSU', p, 'PSU'), false); // gold: product doesn't say gold
  assert.equal(matchesProduct('FSP VITA GM 850W Full Modular ATX3.1 PSU', p, 'PSU'), true);
  assert.equal(matchesProduct('FSP VITA GM 750W Full Modular ATX3.1 PSU', p, 'PSU'), false);
});

test('revision and size words must agree (V2, SFX)', () => {
  const p = 'Lian Li Edge Gold 850W 80+ Gold Modular ATX 3.1 Power Supply - Black';
  assert.equal(matchesProduct('Lian Li EDGE Gold V2 850W 80 PLUS Gold Modular PSU without Hub Black', p, 'PSU'), false);
  assert.equal(matchesProduct('Lian Li EDGE Gold 850W 80 PLUS Gold ATX 3.1 Modular PSU Black', p, 'PSU'), true);
  const v2 = 'Lian LI Edge Gold V2 850W Black without Hub 80 PLUS Gold (EG0850C.B)';
  assert.equal(matchesProduct('Lian Li EDGE Gold V2 850W Black 80 PLUS Gold PSU without Hub', v2, 'PSU'), true);
  assert.equal(matchesProduct('XPG PYMCORE 750W ATX Modular PSU', 'XPG PYMCORE 750W SFX POWER SUPPLY ATX3.1 MODULAR', 'PSU'), false);
});

test('a listing of a different product line with the same wattage is rejected (Lian Li Edge Gold vs RS1000G)', () => {
  const p = 'Lian Li Edge Gold 1000W 80+ Gold Modular ATX 3.1 Power Supply - Black';
  assert.equal(matchesProduct('Lian Li RS1000G Rotational Shift 1000W 80+ Gold Fully Modular ATX Power Supply', p, 'PSU'), false);
  assert.equal(matchesProduct('Lian Li EDGE Gold 1000W 80+ Gold ATX 3.1 Modular PSU Black', p, 'PSU'), true);
  // a bare product with no line name must not take a listing that names its own model code
  assert.equal(matchesProduct('Lian Li RS1000G 1000W 80+ Gold PSU', 'Lian Li 1000W 80+ Gold Modular PSU', 'PSU'), false);
});

test('the product line word is required even when it is the only one', () => {
  const dual = 'ASUS Dual GeForce RTX 5060 8GB OC GDDR7 Graphics Card';
  assert.equal(matchesProduct('ASUS Dual GeForce RTX 5060 8GB GDDR7', dual, 'GPU'), true);
  assert.equal(matchesProduct('ASUS TUF Gaming GeForce RTX 5060 8GB GDDR7', dual, 'GPU'), false);
  assert.equal(matchesProduct('ASUS Prime GeForce RTX 5060 8GB GDDR7', dual, 'GPU'), false);
});

test('search words keep a two-word brand and the product line', () => {
  const p = 'Lian Li Edge Gold 1000W 80+ Gold Modular ATX 3.1 Power Supply - Black';
  assert.deepEqual(buildQueries(p, 'PSU'), ['lian li edge gold 1000w black', 'lian li gold 1000w black', 'lian li 1000w']);
});
