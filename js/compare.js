// Match Polymarket games with Duel events and look for arbs between them.
import { teamScore } from './names.js';
import { marketKey, marketLabel, signed } from './markets.js';

/* ------------------------------ fees & math ------------------------------ */

/**
 * Polymarket taker fee per share: rate * (p * (1 - p)) ^ exponent (USDC, on top of the price).
 * Sports at rate 0.05: $1.25 per 100 shares at p = 0.50.
 */
export const polyFee = (p, fee) => (fee && fee.rate ? fee.rate * Math.pow(p * (1 - p), fee.exponent ?? 1) : 0);
/** Cost of one share that pays $1, fee included. */
export const polyCost = (p, fee, extraPct = 0) => p + polyFee(p, fee) + p * extraPct / 100;

/* -------------------------------- matching -------------------------------- */

/**
 * Pair each Polymarket game with at most one Duel event.
 * Both teams must match; start times must be close. Anything less than certain goes to `doubt`.
 * Returns { pairs:[{ poly, duel, perm, score, dtMin }], doubt:[{ poly, duel, why }], unmatched:[poly] }
 *   perm[i] = Polymarket index of Duel team i
 */
export function matchGames(polyGames, duelEvents, { maxHours = 3, looseMinutes = 20 } = {}) {
  const pairs = [], doubt = [], unmatched = [];
  const taken = new Map(); // duel id -> pair, to catch two Polymarket games claiming one event
  for (const p of polyGames) {
    const cands = [];
    for (const d of duelEvents) {
      const dtMin = Math.abs(p.start - d.start) / 60e3;
      if (dtMin > maxHours * 60) continue;
      const straight = [teamScore(p.teams[0], d.teams[0]), teamScore(p.teams[1], d.teams[1])];
      const crossed = [teamScore(p.teams[0], d.teams[1]), teamScore(p.teams[1], d.teams[0])];
      const s = Math.min(...straight), c = Math.min(...crossed);
      if (Math.max(s, c) < 0.85) continue;
      cands.push({ duel: d, perm: s >= c ? [0, 1] : [1, 0], score: Math.max(s, c), dtMin });
    }
    if (!cands.length) { unmatched.push(p); continue; }
    cands.sort((a, b) => b.score - a.score || a.dtMin - b.dtMin);
    const best = cands[0];
    const sure = best.score >= 0.98 || (best.score >= 0.85 && best.dtMin <= looseMinutes);
    const rival = cands[1] && cands[1].score >= 0.85;
    if (!sure || rival) {
      doubt.push({ poly: p, duel: best.duel, score: best.score, dtMin: best.dtMin, why: rival ? 'несколько похожих матчей на Duel' : 'названия совпадают не полностью' });
      continue;
    }
    if (taken.has(best.duel.id)) {
      const other = taken.get(best.duel.id);
      pairs.splice(pairs.indexOf(other), 1);
      doubt.push({ poly: other.poly, duel: best.duel, score: other.score, dtMin: other.dtMin, why: 'на один матч Duel претендуют два матча Polymarket' });
      doubt.push({ poly: p, duel: best.duel, score: best.score, dtMin: best.dtMin, why: 'на один матч Duel претендуют два матча Polymarket' });
      continue;
    }
    const pair = { poly: p, duel: best.duel, ...best };
    taken.set(best.duel.id, pair);
    pairs.push(pair);
  }
  return { pairs, doubt, unmatched };
}

/** A Duel market rewritten in Polymarket team order (perm from matchGames). */
export function toPolyFrame(m, perm) {
  if (m.kind === 'total' || perm[0] === 0) return m;
  // Duel team 0 is Polymarket team 1: swap sides; handicap of Polymarket team 0 = handicap of Duel team 1
  const line = m.kind === 'hcp' ? -m.line : m.line;
  return { ...m, line, key: marketKey(m.kind, m.scope, m.unit, line), outs: [m.outs[1], m.outs[0]] };
}

/* ---------------------------------- arbs ---------------------------------- */

const levelsOf = list => (list || []).map(a => ({ price: +a.price, size: +a.size })).filter(a => a.price > 0 && a.size > 0);
/** books: Map(token -> { asks, bids }) — a bare asks array is accepted too. */
const sideOf = (books, token, side) => { const b = books?.get(token); return !b ? null : Array.isArray(b) ? (side === 'asks' ? b : null) : b[side]; };

/**
 * Best ask and the book on the way up for one Polymarket token.
 * Falls back to the Gamma top of book (no depth) when the order book is missing.
 */
function askOf(leg, books) {
  const asks = sideOf(books, leg.token, 'asks');
  if (asks) {
    const levels = asks.map(a => ({ price: +a.price, size: +a.size })).filter(a => a.price > 0 && a.size > 0).sort((a, b) => a.price - b.price);
    return levels.length ? { price: levels[0].price, levels, fromBook: true } : null;
  }
  return leg.gammaAsk > 0 ? { price: leg.gammaAsk, levels: null, fromBook: false } : null;
}

const sideLabel = (m, teams, i) => {
  if (m.kind === 'win') return teams[i];
  if (m.kind === 'hcp') return `${teams[i]} ${signed(i === 0 ? m.line : -m.line)}`;
  return i === 0 ? `Больше ${m.line}` : `Меньше ${m.line}`;
};

/**
 * Compare one matched pair. For every market both sites have, try both ways:
 * Polymarket side i + Duel side 1-i. Returns every comparison; `arb` is true when the sum is below 1.
 */
export function comparePair(pair, books, s = {}, now = Date.now()) {
  const { poly, duel, perm } = pair;
  const minPrice = s.minPrice ?? 0.03, maxPrice = s.maxPrice ?? 0.97;
  const duelMarkets = new Map([...duel.markets.values()].map(m => toPolyFrame(m, perm)).map(m => [m.key, m]));
  const out = [];
  for (const pm of poly.markets.values()) {
    const dm = duelMarkets.get(pm.key);
    if (!dm) continue;
    for (const i of [0, 1]) {
      const pLeg = pm.outs[i], dLeg = dm.outs[1 - i];
      const ask = askOf(pLeg, books);
      if (!ask || !dLeg) continue;
      const row = {
        id: `${poly.id}|${pm.key}|${i}`, pi: i, poly, duel, market: pm, label: marketLabel(pm), score: pair.score,
        pSide: sideLabel(pm, poly.teams, i), dSide: sideLabel(pm, poly.teams, 1 - i),
        polyLeg: { ...pLeg, price: ask.price, fromBook: ask.fromBook },
        duelLeg: { ...dLeg },
        qPoly: polyCost(ask.price, pLeg.fee, s.extraPolyPct), qDuel: 1 / dLeg.price,
      };
      const stale = isStale(dLeg.updated || duel.updated, s.maxAgeMin, now);
      row.sum = row.qPoly + row.qDuel;
      row.profitPct = (1 / row.sum - 1) * 100;
      row.problems = [];
      if (ask.price < minPrice || ask.price > maxPrice) row.problems.push(`цена Polymarket ${ask.price} — рынок почти решён`);
      if (stale) row.problems.push(`коэффициент Duel старше ${s.maxAgeMin} мин`);
      if (!ask.fromBook) row.problems.push('нет стакана Polymarket, цена из Gamma');
      row.arb = row.sum < 1 && !row.problems.length;
      row.suspicious = row.arb && row.profitPct > (s.maxProfit ?? 8);
      if (row.arb) Object.assign(row, sizing(row, ask.levels, s));
      out.push(row);
    }
  }
  return out;
}

/**
 * Stakes for a bankroll, and how much the Polymarket book takes while the arb still gives `minProfit`.
 * Buying N shares on Polymarket pays N if that side wins; the Duel stake is N / odds.
 */
export function isStale(updated, maxAgeMin, now = Date.now()) {
  if (!updated || !maxAgeMin) return false;
  return now - new Date(updated).getTime() > maxAgeMin * 60e3;
}

/* ------------------------------- value bets -------------------------------- */

/**
 * Fair probability of each side of a Polymarket market: the middle of the book, fee left out.
 * Side 1 is the mirror of side 0 (buying side 1 = selling side 0), so both mids are averaged.
 * Returns { p:[p0,p1], spread, bid, ask } or null when there is no two-sided book.
 */
export function fairFromBooks(pm, books) {
  const top = i => {
    const asks = levelsOf(sideOf(books, pm.outs[i].token, 'asks')), bids = levelsOf(sideOf(books, pm.outs[i].token, 'bids'));
    if (!asks.length || !bids.length) return null;
    const ask = Math.min(...asks.map(a => a.price)), bid = Math.max(...bids.map(b => b.price));
    const depth = Math.min(asks.find(a => a.price === ask).size * ask, bids.find(b => b.price === bid).size * bid);
    return ask > bid ? { ask, bid, mid: (ask + bid) / 2, spread: ask - bid, depth } : null;
  };
  const t0 = top(0), t1 = top(1);
  const c = [t0 && t0.mid, t1 && 1 - t1.mid].filter(x => x != null);
  if (!c.length) return null;
  const p0 = c.reduce((a, b) => a + b, 0) / c.length;
  const spread = Math.min(...[t0, t1].filter(Boolean).map(t => t.spread));
  const depth = Math.max(...[t0, t1].filter(Boolean).map(t => t.depth)); // USD at the best bid / ask
  // bid / ask of each side; a side without its own book is the mirror of the other one
  const quote = i => { const t = i ? t1 : t0, o = i ? t0 : t1; return t ? { bid: t.bid, ask: t.ask } : { bid: 1 - o.ask, ask: 1 - o.bid }; };
  return { p: [p0, 1 - p0], spread, depth, tops: [t0, t1], quote: [quote(0), quote(1)] };
}

/**
 * Duel bets priced above Polymarket's fair line. EV = p * odds - 1; stake = fractional Kelly of the bank.
 * Problems (wide spread, near-resolved market, stale odds) keep a row out of the list but visible.
 */
export function valueBets(pair, books, s = {}, now = Date.now()) {
  const { poly, duel, perm } = pair;
  const maxSpread = s.maxSpread ?? 0.04, minP = s.minFairP ?? 0.05;
  const duelMarkets = new Map([...duel.markets.values()].map(m => toPolyFrame(m, perm)).map(m => [m.key, m]));
  const out = [];
  for (const pm of poly.markets.values()) {
    const dm = duelMarkets.get(pm.key);
    if (!dm) continue;
    const fair = fairFromBooks(pm, books);
    for (const i of [0, 1]) {
      const dLeg = dm.outs[i];
      if (!dLeg) continue;
      const row = {
        id: `v|${poly.id}|${pm.key}|${i}`, poly, duel, market: pm, label: marketLabel(pm),
        i, side: sideLabel(pm, poly.teams, i), duelLeg: { ...dLeg }, fair, problems: [],
      };
      if (!fair) { row.problems.push('нет двустороннего стакана Polymarket'); out.push(row); continue; }
      row.p = fair.p[i];
      row.fairOdds = 1 / row.p;
      row.ev = row.p * dLeg.price - 1;
      row.evPct = row.ev * 100;
      if (fair.spread > maxSpread) row.problems.push(`спред Polymarket ${fair.spread.toFixed(3)} — цена ненадёжна`);
      const minDepth = s.minDepthUsd ?? 20;
      if (fair.depth < minDepth) row.problems.push(`в стакане Polymarket у лучших цен меньше ${minDepth} $`);
      if (row.p < minP || row.p > 1 - minP) row.problems.push('рынок почти решён');
      if (isStale(dLeg.updated || duel.updated, s.maxAgeMin, now)) row.problems.push(`коэффициент Duel старше ${s.maxAgeMin} мин`);
      const kelly = row.ev > 0 ? row.ev / (dLeg.price - 1) : 0;
      row.kelly = kelly;
      row.stake = (s.valueBank ?? 1000) * (s.kellyFraction ?? 0.25) * kelly;
      row.value = row.ev > 0 && row.evPct >= (s.minEV ?? 3) && !row.problems.length;
      out.push(row);
    }
  }
  return out;
}

export function sizing(row, levels, s = {}) {
  const bank = s.bankroll ?? 100;
  const payout = bank / row.sum;
  const res = {
    payout,
    polyShares: payout, polyUsd: payout * row.qPoly, duelStake: payout * row.qDuel,
    profitUsd: payout - bank,
  };
  if (levels) {
    const limit = 1 / (1 + (s.minProfit ?? 0) / 100);
    let shares = 0, spend = 0;
    for (const lv of levels) {
      const q = polyCost(lv.price, row.polyLeg.fee, s.extraPolyPct);
      if (q + row.qDuel > limit) break;
      shares += lv.size; spend += lv.size * q;
    }
    res.maxShares = shares;
    res.maxBank = shares ? spend + shares * row.qDuel : 0;
    res.bankTooBig = payout > shares;
  }
  if (row.polyLeg.minSize && payout < row.polyLeg.minSize) res.belowMin = row.polyLeg.minSize;
  return res;
}
