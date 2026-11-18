import test from 'node:test';
import assert from 'node:assert/strict';
import { Book, applyMessage } from '../js/live.js';
import { calcArb } from '../js/calc.js';
import { polyCost } from '../js/compare.js';

test('WebSocket order book: snapshot, then level changes (format seen live on 2026-11-18)', () => {
  const books = new Map();
  // the server sends the initial books as an array
  let ch = applyMessage(books, [{ event_type: 'book', asset_id: 'A', timestamp: '1', bids: [{ price: '0.40', size: '10' }], asks: [{ price: '0.52', size: '30' }, { price: '0.55', size: '100' }] }]);
  assert.deepEqual([...ch], ['A']);
  assert.deepEqual(books.get('A').askLevels(), [{ price: 0.52, size: 30 }, { price: 0.55, size: 100 }]);
  // a cheaper ask arrives; the 0.52 level is taken out
  ch = applyMessage(books, { event_type: 'price_change', market: '0x1', timestamp: '2', price_changes: [
    { asset_id: 'A', price: '0.50', size: '12', side: 'SELL', best_bid: '0.40', best_ask: '0.50' },
    { asset_id: 'A', price: '0.52', size: '0', side: 'SELL' },
    { asset_id: 'A', price: '0.41', size: '5', side: 'BUY' },
    { asset_id: 'B', price: '0.30', size: '5', side: 'SELL' }, // no snapshot for B yet: ignored
  ] });
  assert.deepEqual([...ch], ['A']);
  assert.deepEqual(books.get('A').askLevels(), [{ price: 0.5, size: 12 }, { price: 0.55, size: 100 }]);
  assert.equal(books.get('A').bids.get(0.41), 5);
  assert.equal(books.has('B'), false);
  // older message format
  applyMessage(books, { event_type: 'price_change', asset_id: 'A', changes: [{ price: '0.50', size: '0', side: 'SELL' }] });
  assert.deepEqual(books.get('A').askLevels(), [{ price: 0.55, size: 100 }]);
});

test('calculator: bank split gives the same payout on both sides', () => {
  const fee = { rate: 0.05, exponent: 1 };
  const r = calcArb({ price: 0.18, fee, odds: 1.26, mode: 'bank', amount: 100 });
  const q1 = polyCost(0.18, fee);
  assert.ok(Math.abs(r.sum - (q1 + 1 / 1.26)) < 1e-12);
  assert.ok(Math.abs(r.shares - r.duelStake * 1.26) < 0.011);
  assert.ok(Math.abs(r.total - 100) < 0.02);
  assert.ok(r.worst > 1.8 && r.worst < 2); // about +1.9%
  assert.ok(r.feeUsd > 0);
});

test('calculator: fixed Duel stake, rounding, and a losing combination', () => {
  const r = calcArb({ price: 0.3, odds: 1.5, mode: 'duel', amount: 50 });
  assert.equal(r.duelStake, 50);
  assert.equal(r.shares, 75);
  const rounded = calcArb({ price: 0.3, odds: 1.5, mode: 'bank', amount: 100, roundDuel: 5 });
  assert.equal(rounded.duelStake % 5, 0);
  assert.ok(Math.abs(rounded.shares - rounded.duelStake * 1.5) < 0.011);
  const bad = calcArb({ price: 0.5, odds: 1.8, mode: 'bank', amount: 100 });
  assert.ok(bad.worst < 0);
  assert.equal(calcArb({ price: 1.2, odds: 2, amount: 10 }), null);
});
