import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanRetailerPrices, marketPriceFrom, categoryGroup, isPcCategory, round2 } from '../src/utils/pricing.js';

test('market price is the lowest in-stock price', () => {
  const list = cleanRetailerPrices([
    { retailer: 'A', price: 100, inStock: true },
    { retailer: 'B', price: 90, inStock: false },
    { retailer: 'C', price: 95.5 },
  ]);
  assert.deepEqual(marketPriceFrom(list), { marketPrice: 95.5, noStock: false });
});

test('falls back to lowest listed price when nothing is in stock', () => {
  const list = cleanRetailerPrices([{ retailer: 'A', price: 100, inStock: false }, { retailer: 'B', price: 90, inStock: false }]);
  assert.deepEqual(marketPriceFrom(list), { marketPrice: 90, noStock: true });
});

test('rejects bad retailer input', () => {
  assert.throws(() => cleanRetailerPrices([]));
  assert.throws(() => cleanRetailerPrices([{ retailer: '', price: 5 }]));
  assert.throws(() => cleanRetailerPrices([{ retailer: 'A', price: -1 }]));
});

test('category helpers', () => {
  assert.equal(categoryGroup('GPU / Nvidia / RTX50'), 'GPU');
  assert.equal(isPcCategory('DRAM / DDR5'), true);
  assert.equal(isPcCategory('Cable / HDMI'), false);
  assert.equal(round2(10.005 + 5), 15.01);
});
