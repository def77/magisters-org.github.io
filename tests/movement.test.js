import test from 'node:test';
import assert from 'node:assert/strict';
import { LineLog } from '../js/movement.js';

const K = 'win|match|maps|0', M = 60e3;

test('Duel price changes are recorded, repeats are not', () => {
  const log = new LineLog();
  log.duelPrices(K, [1.26, 3.85], 0);
  log.duelPrices(K, [1.26, 3.85], 2 * M);
  log.duelPrices(K, [1.30, 3.60], 5 * M);
  assert.deepEqual(log.duelHistory(K, 1).map(h => h.price), [3.85, 3.6]);
  assert.equal(log.duelHistory(K, 0).length, 2);
});

test('Duel lags: Polymarket moved 5 p.p. while Duel kept its price', () => {
  const log = new LineLog();
  log.duelPrices(K, [1.26, 3.85], 0);
  log.fairP(K, 0.75, 0);         // side 1 = 25%
  log.fairP(K, 0.70, 10 * M);    // side 1 = 30% now
  const s = log.signal(K, 1, 10 * M, { minMove: 0.03 });
  assert.ok(s.lags);
  assert.ok(Math.abs(s.delta - 0.05) < 1e-9);
  assert.equal(s.changed, null);
  // the other side moved down by the same amount and also lags
  assert.ok(Math.abs(log.signal(K, 0, 10 * M).delta + 0.05) < 1e-9);
});

test('no lag once Duel follows, or when the move is small or too recent', () => {
  const log = new LineLog();
  log.duelPrices(K, [1.26, 3.85], 0);
  log.fairP(K, 0.75, 0);
  log.fairP(K, 0.70, 10 * M);
  log.duelPrices(K, [1.36, 3.2], 11 * M); // Duel moved after Polymarket
  const s = log.signal(K, 1, 12 * M);
  assert.equal(s.lags, false);
  assert.deepEqual(s.changed && [s.changed.from, s.changed.to], [3.85, 3.2]);
  const small = new LineLog();
  small.duelPrices(K, [1.26, 3.85], 0); small.fairP(K, 0.75, 0); small.fairP(K, 0.74, 10 * M);
  assert.equal(small.signal(K, 1, 10 * M).lags, false);
  const fresh = new LineLog();
  fresh.duelPrices(K, [1.26, 3.85], 0); fresh.fairP(K, 0.75, 0); fresh.fairP(K, 0.65, 30e3);
  assert.equal(fresh.signal(K, 1, 30e3).lags, false); // Duel had only 30 s to react
});

test('fair line lookup uses the record at or before a moment', () => {
  const log = new LineLog();
  log.fairP(K, 0.6, 5 * M); log.fairP(K, 0.62, 6 * M); log.fairP(K, 0.6204, 7 * M); // tiny change is merged
  assert.equal(log.fair.get(K).length, 2);
  assert.equal(log.fairAt(K, 0, 0), 0.6);      // before the first record -> first record
  assert.equal(log.fairAt(K, 0, 6.5 * M), 0.62);
  assert.ok(Math.abs(log.fairAt(K, 1, 6.5 * M) - 0.38) < 1e-12);
});
