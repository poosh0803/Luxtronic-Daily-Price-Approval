import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStaticIce, mapCentrecom } from '../src/lookup.js';

const row = (price, name, store, href) => `
<tr valign="top"><td align="left"><a href="${href}" target="_blank">$${price}</a><br></td>
<td valign="bottom">${name}<br><font color="#808080"><a title="Click to visit the ${store} web site" href="/x"><img src="/l.png"> <b><font>${store}</font></b></a> (NSW)  | www.x.com.au | updated: 17-10-2026</td></tr>`;

test('parses StaticICE rows and unwraps the redirect url', () => {
  const html = `<table>
    ${row('679.00', 'AMD Ryzen 7 9800X3D Desktop Processor', 'Scorptec', '/cgi-bin/redirect.cgi?name=Scorptec&newurl=https%3A%2F%2Fwww.scorptec.com.au%2Fproduct%2Fx&query=q')}
    <tr valign="top"><td>only one cell</td></tr>
    ${row('n/a', 'No price', 'Nobody', '/y')}
  </table>`;
  const rows = parseStaticIce(html);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { store: rows[0].store, location: rows[0].location, price: rows[0].price, updated: rows[0].updated, url: rows[0].url, inStock: rows[0].inStock },
    { store: 'Scorptec', location: 'NSW', price: 679, updated: '17-10-2026', url: 'https://www.scorptec.com.au/product/x', inStock: null },
  );
  assert.equal(rows[0].name, 'AMD Ryzen 7 9800X3D Desktop Processor');
});

test('maps Centrecom stock labels', () => {
  const rows = mapCentrecom({ p: [
    { name: 'A', price: 599, wasPrice: 655, seName: 'a', stockAvailablity: 'IN STOCK', stockQuantity: 5 },
    { name: 'B', price: 100, seName: 'b', stockAvailablity: 'INSTORE ONLY', stockQuantity: 0 },
    { name: 'C', price: 100, seName: 'c', stockAvailablity: 'PRE-ORDER', stockQuantity: 0 },
    { name: 'D', price: 0, seName: 'd', stockAvailablity: 'IN STOCK', stockQuantity: 1 },
  ] });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.inStock), [true, true, false]);
  assert.equal(rows[0].wasPrice, 655);
  assert.equal(rows[0].url, 'https://www.centrecom.com.au/a');
});

import { mapMwave, matchesQuery } from '../src/lookup.js';

test('maps Mwave suggest results', () => {
  const rows = mapMwave({ resources: { results: { products: [
    { title: 'AMD Ryzen 7 9800X3D CPU', price: '648.00', compare_at_price_max: '0.00', available: true, url: '/products/x?_pos=1&q=a' },
    { title: 'Sold out thing', price: '100.00', compare_at_price_max: '120.00', available: false, url: '/products/y' },
  ] } } });
  assert.equal(rows[0].price, 648);
  assert.equal(rows[0].url, 'https://www.mwave.com.au/products/x');
  assert.equal(rows[0].inStock, true);
  assert.equal(rows[1].inStock, false);
  assert.equal(rows[1].wasPrice, 120);
});

test('matchesQuery requires every word', () => {
  assert.equal(matchesQuery('AMD Ryzen 7 9800X3D 8 Core', 'ryzen 7 9800x3d'), true);
  assert.equal(matchesQuery('AMD Ryzen 7 7800X3D 8 Core', 'ryzen 7 9800x3d'), false);
});

import { parseOffer } from '../src/lookup.js';

test('parseOffer reads JSON-LD (Scorptec style)', () => {
  const html = `<script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":"679","availability":"https://schema.org/InStock"}}</script>`;
  assert.deepEqual(parseOffer(html), { price: 679, inStock: true, availability: 'In Stock' });
});

test('parseOffer reads microdata (PC Case Gear style) and out of stock', () => {
  const html = `<div itemprop="offers" itemscope><meta itemprop="availability" content="https://schema.org/OutOfStock"/><div itemprop="price" content="1,299">x</div></div>`;
  assert.equal(parseOffer(html).price, 1299); // thousands separator must not truncate to 1
  const ok = `<div itemprop="offers" itemscope><meta itemprop="availability" content="https://schema.org/OutOfStock"/><div itemprop="price" content="1299">x</div></div>`;
  assert.deepEqual(parseOffer(ok), { price: 1299, inStock: false, availability: 'Out Of Stock' });
});
