// Glue: match Polymarket games to bookmaker events, build quotes, find arbs.
import { findMatch } from './match.js';
import { findArbs, bestBook, polyCost, bookCost, bookDepth, maxBankrollFromLeg } from './arb.js';
import { EXCHANGE_KEYS } from './config.js';
import { isStale } from './esports.js';

export function buildQuotes(poly, odds, bookNames, s) {
  const n = poly.outcomes.length;
  const all = [...Array(n).keys()];
  const whitelist = s.bookmakers ? new Set(s.bookmakers.split(',').map(x => x.trim()).filter(Boolean)) : null;
  const quotes = [];
  poly.outcomes.forEach((o, i) => {
    if (o.yes?.ask > 0 && o.yes.ask < 1) quotes.push({
      set: [i], q: polyCost(o.yes.ask, s.polyFee, o.yes.fee), src: 'poly', book: 'Polymarket', bookKey: 'polymarket',
      side: 'YES', price: o.yes.ask, bid: o.yes.bid, tick: o.yes.tick, token: o.yes.token, fee: o.yes.fee, mkey: 'match', out: i, label: o.name, url: poly.url,
    });
    if (n > 2 && o.no?.ask > 0 && o.no.ask < 1) quotes.push({
      set: all.filter(j => j !== i), q: polyCost(o.no.ask, s.polyFee, o.no.fee), src: 'poly', book: 'Polymarket', bookKey: 'polymarket',
      side: 'NO', price: o.no.ask, bid: o.no.bid, tick: o.no.tick, token: o.no.token, fee: o.no.fee, mkey: 'match', label: `НЕ ${o.name}`, url: poly.url,
    });
  });
  for (const b of odds.books) {
    if (whitelist && !whitelist.has(b.key)) continue;
    if (isStale(b.updated, s.maxQuoteAgeMin)) continue;
    const comm = EXCHANGE_KEYS.test(b.key) ? s.exchangeCommission : 0;
    bookNames.forEach((name, i) => {
      const o = b.prices[name];
      if (o > 1) quotes.push({
        set: [i], q: bookCost(o, comm), src: 'book', book: b.title, bookKey: b.key,
        side: 'BACK', price: o, label: poly.outcomes[i].name, mkey: 'match', out: i, bookOutcome: name, updated: b.updated,
      });
    });
  }
  return quotes;
}

export function scan(polyGames, oddsBySport, s) {
  const matches = [], unmatched = [];
  for (const g of polyGames) {
    const pool = oddsBySport[g.sport] || [];
    const m = findMatch(g, pool, { timeTolerance: s.timeTolerance, threshold: s.matchThreshold });
    if (!m) { unmatched.push(g); continue; }
    const quotes = buildQuotes(g, m.event, m.names, s);
    const n = g.outcomes.length;
    const arbs = findArbs(n, quotes, { includeBookOnly: s.includeBookOnly, minProfit: s.minProfit });
    const best = bestBook(n, quotes, { includeBookOnly: s.includeBookOnly });
    matches.push({ poly: g, odds: m.event, score: m.score, quotes, arbs, best });
  }
  return { matches, unmatched };
}

/** Refine arbs with real order-book depth. books: Map(token -> asks). Mutates arbs. */
export function applyDepth(arb, books, s) {
  // pass 1: replace Gamma top-of-book with the live CLOB best ask
  for (const leg of arb.legs) {
    const asks = leg.src === 'poly' && books.get(leg.token);
    if (!asks) continue;
    const bestAsk = Math.min(...asks.map(a => +a.price));
    if (isFinite(bestAsk)) { leg.price = bestAsk; leg.q = polyCost(bestAsk, s.polyFee, leg.fee); }
    else leg.q = 1; // empty book: nothing to buy
  }
  arb.sum = arb.legs.reduce((a, l) => a + l.q, 0);
  // pass 2: liquidity available while the arb stays above minProfit
  let maxBank = Infinity;
  for (const leg of arb.legs) {
    const asks = leg.src === 'poly' && books.get(leg.token);
    if (!asks) continue;
    const others = arb.sum - leg.q;
    const feePct = (leg.q / leg.price - 1) * 100; // effective fee at the touch
    leg.depth = bookDepth(asks, others, feePct, s.minProfit, arb.minCover || 1);
    maxBank = Math.min(maxBank, maxBankrollFromLeg(arb, leg, leg.depth.usd * (1 + feePct / 100)));
  }
  arb.profitPct = ((arb.minCover || 1) / arb.sum - 1) * 100;
  arb.maxBankroll = isFinite(maxBank) ? maxBank : null;
  return arb;
}
