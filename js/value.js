// Value bets and middles.
//
// Value bet: a sharp bookmaker (Pinnacle by default) with its margin removed gives fair probabilities p_i.
// A quote with effective cost q (Polymarket ask + fee, or 1/odds at a bookmaker) has
//   EV = p_i / q - 1        (expected profit per $1 staked)
// Kelly stake fraction for net odds b = 1/q - 1:  f = (b*p - (1-p)) / b = EV / b.
//
// Middle: two bets on opposite sides with different lines, e.g. team0 +2.5 and team1 -1.5,
// or Over 21.5 and Under 23.5. If the result lands between the lines both bets win;
// otherwise exactly one wins (lines are half-points, so there are no pushes).
// Stakes are set so that a single win pays the same either way.

/** Fair probabilities from the sharp book's prices on every outcome (multiplicative de-vig). */
export function fairProbs(n, quotes, sharpKey = 'pinnacle') {
  const prices = [];
  for (let i = 0; i < n; i++) {
    const q = quotes.find(x => x.src === 'book' && x.bookKey === sharpKey && x.set.length === 1 && x.set[0] === i);
    if (!q) return null;
    prices.push(+q.price);
  }
  const inv = prices.map(p => 1 / p);
  const sum = inv.reduce((a, b) => a + b, 0);
  return { probs: inv.map(x => x / sum), margin: sum - 1, prices };
}

/**
 * Value bets in one market.
 * quotes: [{ set:[i], q, src, bookKey, ... }]   (only single-outcome quotes are considered)
 * opts: { sharpKey, minEV (%), kellyFraction (0..1), bankroll, polyOnly }
 */
export function valueBets(n, quotes, { sharpKey = 'pinnacle', minEV = 2, kellyFraction = 0.25, bankroll = 1000, polyOnly = false } = {}) {
  const fair = fairProbs(n, quotes, sharpKey);
  if (!fair) return [];
  const out = [];
  for (const q of quotes) {
    if (q.set.length !== 1 || q.bookKey === sharpKey) continue;
    if (polyOnly && q.src !== 'poly') continue;
    if (!(q.q > 0 && q.q < 1)) continue;
    const p = fair.probs[q.set[0]];
    const ev = p / q.q - 1;
    if (ev * 100 < minEV) continue;
    const b = 1 / q.q - 1;
    const kelly = Math.max(0, ev / b);
    out.push({ quote: q, p, fairOdds: 1 / p, evPct: ev * 100, kelly, stake: bankroll * kelly * kellyFraction, sharpMargin: fair.margin });
  }
  return out.sort((a, b) => b.evPct - a.evPct);
}

const isHalf = x => Math.abs((Math.abs(x) * 2) % 2 - 1) < 1e-9; // 1.5, 2.5, ... (no push possible)

/**
 * Two-leg numbers: equal payout P on a single win.
 * Returns loss% if only one wins (negative = still profit) and gain% if both win, both relative to total stake.
 */
export function middleNumbers(q1, q2) {
  const sum = q1 + q2;
  return { sum, singlePct: (1 / sum - 1) * 100, bothPct: (2 / sum - 1) * 100, share1: q1 / sum, share2: q2 / sum };
}

/**
 * Middles across lines of the same match and period.
 * entries: [{ type:'hcp'|'total', period, line, quotes:[[outcome0 quotes], [outcome1 quotes]] }]
 *   hcp:   line = handicap of team 0; outcome 0 = team 0 at +line, outcome 1 = team 1 at -line
 *   total: outcome 0 = Over line, outcome 1 = Under line
 * opts: { maxLoss (%), includeBookOnly }
 */
export function findMiddles(entries, { maxLoss = 3, includeBookOnly = false } = {}) {
  const groups = new Map();
  for (const e of entries) {
    if ((e.type !== 'hcp' && e.type !== 'total') || !isHalf(e.line)) continue;
    const k = e.type + '|' + e.period;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const best = list => list.reduce((m, q) => (!m || q.q < m.q ? q : m), null);
  const out = [];
  for (const list of groups.values()) {
    for (const a of list) for (const b of list) {
      // hcp: team0 at +a.line with team1 at -b.line wins both when a.line > b.line
      // total: Over a.line with Under b.line wins both when b.line > a.line
      const width = a.type === 'hcp' ? a.line - b.line : b.line - a.line;
      if (!(width > 0)) continue;
      const l1 = best(a.quotes[0] || []), l2 = best(b.quotes[1] || []);
      if (!l1 || !l2) continue;
      const hasPoly = l1.src === 'poly' || l2.src === 'poly';
      if (!hasPoly && !includeBookOnly) continue;
      const n = middleNumbers(l1.q, l2.q);
      if (-n.singlePct > maxLoss) continue;
      out.push({ type: a.type, period: a.period, width, legs: [{ ...l1, line: a.line, side: 0 }, { ...l2, line: b.line, side: 1 }], ...n });
    }
  }
  return out.sort((x, y) => y.singlePct - x.singlePct || y.width - x.width);
}
