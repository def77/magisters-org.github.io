// Pure arbitrage math. No DOM, no network — easy to unit-test.
//
// A market has N mutually exclusive outcomes (2 for moneyline, 3 for 1X2).
// A quote is a way to buy $1 of payout if any outcome in `set` happens, for cost `q`
// (q is the effective implied probability, fees included):
//   Polymarket YES at ask p, fee f:     q = p * (1 + f)
//   Polymarket NO on outcome i:          set = all outcomes except i
//   Bookmaker decimal odds o:            q = 1 / o
//   Exchange with commission c:          q = 1 / (1 + (o - 1) * (1 - c))
// An arbitrage is a partition of outcomes into blocks, one quote per block, with sum(q) < 1.

/**
 * Polymarket taker fee as a fraction of cost: rate * (p * (1 - p)) ^ exponent
 * (feeSchedule from Gamma, e.g. sports_fees_v3 = { rate: 0.05, exponent: 1 } → 1.25% at p = 0.5).
 */
export const polyFeeRate = (ask, sched) =>
  sched && sched.rate ? sched.rate * Math.pow(ask * (1 - ask), sched.exponent ?? 1) : 0;
export const polyCost = (ask, extraPct = 0, sched = null) => ask * (1 + polyFeeRate(ask, sched) + extraPct / 100);
export const bookCost = (odds, commissionPct = 0) => 1 / (1 + (odds - 1) * (1 - commissionPct / 100));

/** All set partitions of [0..n-1]. n is tiny (2 or 3). */
export function partitions(n) {
  const res = [];
  const rec = (i, blocks) => {
    if (i === n) { res.push(blocks.map(b => [...b])); return; }
    for (const b of blocks) { b.push(i); rec(i + 1, blocks); b.pop(); }
    blocks.push([i]); rec(i + 1, blocks); blocks.pop();
  };
  rec(0, []);
  return res.filter(p => p.length > 1); // a single block covering everything is not a bet
}

const keyOf = set => [...set].sort((a, b) => a - b).join(',');

/**
 * Find arbitrage combinations for one market.
 * quotes: [{ set:number[], q:number, src:'poly'|'book', ... }]
 * opts: { includeBookOnly, minProfit (%) }
 * Returns [{ legs, sum, profitPct }] sorted by profit desc (best per partition).
 */
export function findArbs(n, quotes, { includeBookOnly = false, minProfit = 0 } = {}) {
  // best quote per (set, src)
  const best = new Map();
  for (const qt of quotes) {
    if (!(qt.q > 0 && qt.q < 1)) continue;
    const k = keyOf(qt.set) + '|' + qt.src;
    const cur = best.get(k);
    if (!cur || qt.q < cur.q) best.set(k, qt);
  }
  const out = [];
  for (const part of partitions(n)) {
    const options = part.map(block => {
      const k = keyOf(block);
      return ['poly', 'book'].map(s => best.get(k + '|' + s)).filter(Boolean);
    });
    if (options.some(o => !o.length)) continue;
    let bestCombo = null;
    for (const combo of cartesian(options)) {
      const hasPoly = combo.some(l => l.src === 'poly');
      const hasBook = combo.some(l => l.src === 'book');
      if (!hasPoly && !includeBookOnly) continue;
      if (!hasBook && hasPoly) continue; // poly-only arb is just a mispriced book on one venue
      const sum = combo.reduce((a, l) => a + l.q, 0);
      if (!bestCombo || sum < bestCombo.sum) bestCombo = { legs: combo, sum };
    }
    if (!bestCombo) continue;
    const profitPct = (1 / bestCombo.sum - 1) * 100;
    if (profitPct >= minProfit) out.push({ ...bestCombo, profitPct });
  }
  return out.sort((a, b) => b.profitPct - a.profitPct);
}

/** Lowest total implied probability over all valid combos (for the "near arbs" view). */
export function bestBook(n, quotes, opts = {}) {
  const all = findArbs(n, quotes, { ...opts, minProfit: -Infinity });
  return all[0] || null;
}

function* cartesian(lists, i = 0, acc = []) {
  if (i === lists.length) { yield [...acc]; return; }
  for (const x of lists[i]) { acc.push(x); yield* cartesian(lists, i + 1, acc); acc.pop(); }
}

/**
 * Stakes for total bankroll B: stake_k = B * q_k / sum, every outcome pays B / sum.
 * For Polymarket legs also returns number of shares (stake / (ask * (1+fee))).
 */
export function stakes(arb, bankroll) {
  const payout = bankroll / arb.sum;
  return {
    payout,
    profit: payout - bankroll,
    legs: arb.legs.map(l => {
      const stake = bankroll * l.q / arb.sum;
      return { ...l, stake, shares: l.src === 'poly' ? payout : null };
    }),
  };
}

/**
 * Dollars available on a Polymarket ask book while the arb is still >= minProfit.
 * asks: [{price, size}] (any order). othersQ: sum of q of the other legs.
 * Returns { usd, shares, vwap, bestAsk } of the fillable part.
 */
export function bookDepth(asks, othersQ, feePct = 0, minProfit = 0) {
  const maxSum = 1 / (1 + minProfit / 100);
  const limit = (maxSum - othersQ) / (1 + feePct / 100);
  let usd = 0, shares = 0;
  const sorted = [...asks].map(a => ({ price: +a.price, size: +a.size })).sort((a, b) => a.price - b.price);
  for (const a of sorted) {
    if (a.price > limit + 1e-12) break;
    usd += a.price * a.size; shares += a.size;
  }
  return { usd, shares, vwap: shares ? usd / shares : null, bestAsk: sorted[0]?.price ?? null, limit };
}

/** Max total bankroll for the arb given USD liquidity on one leg. */
export function maxBankrollFromLeg(arb, leg, legUsd) {
  return legUsd * arb.sum / leg.q;
}
