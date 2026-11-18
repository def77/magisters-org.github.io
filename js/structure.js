// 1) Limit ("maker") arbs on Polymarket and 2) cross-market arbs.
import { findArbs } from './arb.js';

/* ---------- 1. limit orders ---------- */

/**
 * Price for a resting buy order: one tick above the best bid while that is still below the ask,
 * otherwise join the best bid. Polymarket sports fees are taker-only, so a maker pays no fee.
 * (Polymarket also pays makers a rebate — not counted here, so real results are slightly better.)
 */
export function makerPrice({ ask, bid, tick = 0.01 }) {
  if (!(bid > 0) || !(ask > 0)) return null;
  const up = Math.round((bid + tick) * 1e4) / 1e4;
  const p = up < ask - 1e-9 ? up : bid;
  return p > 0 && p < 1 ? p : null;
}

/** Same quotes, Polymarket ones re-priced as resting limit orders. */
export function makerVariant(quotes, s = {}) {
  const out = [];
  for (const q of quotes) {
    if (q.src !== 'poly') { out.push(q); continue; }
    const p = makerPrice({ ask: q.price, bid: q.bid, tick: q.tick });
    if (p == null) continue;
    out.push({ ...q, price: p, q: p * (1 + (s.polyFee || 0) / 100), fee: null, maker: true, side: 'LIMIT', takerPrice: q.price });
  }
  return out;
}

/** Arbs that only exist (or are better) when Polymarket legs are limit orders. */
export function makerArbs(n, quotes, s = {}) {
  const taker = findArbs(n, quotes, { includeBookOnly: s.includeBookOnly, minProfit: -Infinity })[0];
  const best = taker ? taker.profitPct : -Infinity;
  return findArbs(n, makerVariant(quotes, s), { includeBookOnly: false, minProfit: s.minProfit })
    .filter(a => a.legs.some(l => l.maker) && a.profitPct > Math.max(best, s.minProfit ?? 0) + 0.05);
}

/* ---------- 2. cross-market arbs ---------- */

// Best-of-3 match: four final scores. Each market side covers some of them.
export const BO3_STATES = ['2:0', '2:1', '1:2', '0:2']; // from team 0's point of view
const BO3_COVER = {
  'ml|result|0': [[0, 1], [2, 3]],
  'hcp|result|1.5': [[0, 1, 2], [3]],   // team0 +1.5 | team1 -1.5
  'hcp|result|-1.5': [[0], [1, 2, 3]],  // team0 -1.5 | team1 +1.5
  'total|result|2.5': [[1, 2], [0, 3]], // over 2.5 maps | under
};

/** Is this a best-of-3 (from the title, or from the presence of ±1.5 map handicaps / 2.5 map totals)? */
export const isBo3 = (title, keys) => /\bBO3\b/i.test(title || '') || keys.some(k => k in BO3_COVER && k !== 'ml|result|0');

/**
 * Buy several outcomes, the same payout units on each, so every final state pays at least once.
 * legs: [{ covers:[state idx], q, src, mkey, ... }]
 * Returns combos with min payout / cost > 1 (+ minProfit). Each leg costs q per unit; profit = minCover / sum - 1.
 */
export function coverArbs(nStates, legs, { minProfit = 0, maxLegs = 3, requirePoly = true, polyOnly = false, minMarkets = 2, includeBookOnly = false } = {}) {
  // keep the cheapest leg per (covered states, venue type)
  const best = new Map();
  for (const l of legs) {
    if (!(l.q > 0 && l.q < 1)) continue;
    if (polyOnly && l.src !== 'poly') continue;
    const k = l.covers.join(',') + '|' + l.src;
    const cur = best.get(k);
    if (!cur || l.q < cur.q) best.set(k, l);
  }
  const pool = [...best.values()];
  const out = [];
  const seen = new Set();
  const rec = (start, combo) => {
    if (combo.length >= 2) {
      const counts = Array(nStates).fill(0);
      combo.forEach(l => l.covers.forEach(i => counts[i]++));
      const minCover = Math.min(...counts);
      const markets = new Set(combo.map(l => l.mkey)).size;
      const hasPoly = combo.some(l => l.src === 'poly');
      if (minCover >= 1 && markets >= minMarkets && (hasPoly || !requirePoly || includeBookOnly)) {
        const sum = combo.reduce((a, l) => a + l.q, 0);
        const profitPct = (minCover / sum - 1) * 100;
        const key = combo.map(l => l.mkey + ':' + l.covers.join('') + ':' + l.src).sort().join('/');
        if (profitPct >= minProfit && !seen.has(key)) {
          seen.add(key);
          out.push({ legs: [...combo], sum, minCover, profitPct, maxPct: (Math.max(...counts) / sum - 1) * 100, counts });
        }
      }
    }
    if (combo.length === maxLegs) return;
    for (let i = start; i < pool.length; i++) { combo.push(pool[i]); rec(i + 1, combo); combo.pop(); }
  };
  rec(0, []);
  // drop combos that contain a cheaper complete combo (adding a leg never helps the minimum)
  return out.sort((a, b) => b.profitPct - a.profitPct)
    .filter((a, _, all) => !all.some(b => b !== a && b.legs.length < a.legs.length && b.profitPct >= a.profitPct && b.legs.every(l => a.legs.includes(l))));
}

/** Esports: cover arbs over the BO3 score space from all lines of a match (Polymarket + books). */
export function bo3Covers(entries, s = {}) {
  const legs = [];
  for (const e of entries) {
    const cov = BO3_COVER[e.key];
    if (!cov) continue;
    e.quotes.forEach((list, i) => list.forEach(q => legs.push({ ...q, covers: cov[i] })));
  }
  return coverArbs(4, legs, { minProfit: s.minProfit, includeBookOnly: s.includeBookOnly });
}

/** Classic 1X2 / moneyline: arbs inside Polymarket alone (YES on every outcome, or NO bundles). */
export function polymarketInternal(n, quotes, s = {}) {
  const legs = quotes.filter(q => q.src === 'poly').map(q => ({ ...q, covers: q.set, mkey: q.side + q.set.join('') }));
  return coverArbs(n, legs, { minProfit: s.minProfit, polyOnly: true, minMarkets: 2, maxLegs: n });
}
