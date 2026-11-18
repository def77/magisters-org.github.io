import test from 'node:test';
import assert from 'node:assert/strict';
import { similarity, findMatch } from '../js/match.js';
import { findArbs, partitions, stakes, bookDepth, bookCost } from '../js/arb.js';
import { parsePolyEvent, parseOddsEvent } from '../js/sources.js';
import { scan, applyDepth } from '../js/scanner.js';
import { demoData, demoBooks } from '../js/demo.js';
import { DEFAULT_SETTINGS, DEFAULT_SPORTS } from '../js/config.js';

test('team similarity', () => {
  assert.ok(similarity('Lakers', 'Los Angeles Lakers') >= 0.8);
  assert.ok(similarity('Man Utd', 'Manchester United') === 1);
  assert.ok(similarity('PSG', 'Paris Saint-Germain') >= 0.8);
  assert.ok(similarity('Arsenal FC', 'Arsenal') === 1);
  assert.ok(similarity('Lakers', 'Boston Celtics') < 0.4);
  assert.equal(similarity('Draw', 'Draw'), 1);
  assert.equal(similarity('Draw', 'Arsenal'), 0);
});

test('partitions', () => {
  assert.equal(partitions(2).length, 1);
  assert.equal(partitions(3).length, 4); // {0}{1}{2}, {01}{2}, {02}{1}, {0}{12}
});

test('two-way arb and stakes', () => {
  const quotes = [
    { set: [0], q: 0.41, src: 'poly' },
    { set: [1], q: 1 / 1.74, src: 'book' },
    { set: [1], q: 1 / 1.60, src: 'book' },
  ];
  const [a] = findArbs(2, quotes);
  assert.ok(a && Math.abs(a.profitPct - (1 / (0.41 + 1 / 1.74) - 1) * 100) < 1e-9);
  const st = stakes(a, 1000);
  const payouts = st.legs.map(l => l.src === 'poly' ? l.stake / l.q : l.stake / l.q);
  for (const p of payouts) assert.ok(Math.abs(p - st.payout) < 1e-6);
});

test('poly-only and book-only filtered by default', () => {
  const quotes = [{ set: [0], q: 0.4, src: 'book' }, { set: [1], q: 0.5, src: 'book' }];
  assert.equal(findArbs(2, quotes).length, 0);
  assert.equal(findArbs(2, quotes, { includeBookOnly: true }).length, 1);
});

test('exchange commission lowers effective odds', () => {
  assert.ok(Math.abs(bookCost(2, 0) - 0.5) < 1e-12);
  assert.ok(bookCost(2, 5) > 0.5);
});

test('order book depth', () => {
  const asks = [{ price: '0.43', size: '100' }, { price: '0.41', size: '200' }, { price: '0.50', size: '1000' }];
  const d = bookDepth(asks, 0.55, 0, 0); // limit 0.45
  assert.equal(d.bestAsk, 0.41);
  assert.equal(d.shares, 300);
  assert.ok(Math.abs(d.usd - (0.41 * 200 + 0.43 * 100)) < 1e-9);
});

test('end-to-end on demo data', () => {
  const s = { ...DEFAULT_SETTINGS, minProfit: 0.1 };
  const d = demoData();
  const sports = DEFAULT_SPORTS.filter(x => ['nba', 'epl'].includes(x.id));
  const poly = sports.flatMap(sp => d.gamma[sp.id].map(e => parsePolyEvent(e, sp)).filter(Boolean));
  assert.equal(poly.length, 5);
  const odds = Object.fromEntries(sports.map(sp => [sp.id, d.odds[sp.id].map(parseOddsEvent)]));
  const res = scan(poly, odds, s);
  assert.equal(res.matches.length, 5, 'all demo games matched: ' + res.unmatched.map(u => u.title));
  const arbs = res.matches.flatMap(m => m.arbs.map(a => ({ ...a, match: m })));
  const titles = new Set(arbs.map(a => a.match.poly.title));
  assert.ok(titles.has('Lakers vs. Celtics'));
  assert.ok(titles.has('Arsenal vs. Chelsea'));
  assert.ok(!titles.has('Warriors vs. Nuggets'));
  const books = demoBooks(arbs.flatMap(a => a.legs.map(l => l.token)), poly.flatMap(g => g.outcomes.flatMap(o => [o.yes, o.no].filter(Boolean))));
  for (const a of arbs) {
    applyDepth(a, books, s);
    assert.ok(a.maxBankroll > 0);
  }
});

test('gamma parser: moneyline without sportsMarketType, skips futures', () => {
  const sp = DEFAULT_SPORTS.find(x => x.id === 'nba');
  const g = parsePolyEvent({
    id: 1, slug: 'nba-a-b-2026-11-08', title: 'A vs. B',
    markets: [
      { id: 's', question: 'Spread: A (-4.5)', outcomes: '["A","B"]', clobTokenIds: '["1","2"]', bestAsk: 0.5, bestBid: 0.49 },
      { id: 'm', question: 'A vs. B', outcomes: '["A","B"]', clobTokenIds: '["3","4"]', bestAsk: 0.6, bestBid: 0.58 },
    ],
  }, sp);
  assert.equal(g.outcomes[0].yes.token, '3');
  assert.ok(Math.abs(g.outcomes[1].yes.ask - 0.42) < 1e-9);
  assert.equal(g.dateHint, '2026-11-08');
  const fut = parsePolyEvent({ id: 2, slug: 'nba-champion', title: 'NBA Champion', markets: [
    { id: 'x', question: 'Will the Lakers win the 2027 NBA Finals?', outcomes: '["Yes","No"]', bestAsk: 0.1 },
  ] }, sp);
  assert.equal(fut, null);
});

test('findMatch respects time window', () => {
  const t = new Date('2026-11-08T00:00:00Z');
  const pg = { start: t, outcomes: [{ name: 'Lakers' }, { name: 'Celtics' }] };
  const ev = { start: new Date(t.getTime() + 24 * 3600e3), outcomeNames: ['Los Angeles Lakers', 'Boston Celtics'] };
  assert.equal(findMatch(pg, [ev], { timeTolerance: 6 }), null);
  assert.ok(findMatch(pg, [{ ...ev, start: t }], { timeTolerance: 6 }));
});

import { parseGammaEsports, matchFixture, oddsPapiLines, esportsArbs, hcpForParticipant1, outcomeLabel } from '../js/esports.js';
import { demoEsports } from '../js/demo.js';
import { polyCost, polyFeeRate } from '../js/arb.js';

test('polymarket fee schedule', () => {
  const sched = { rate: 0.05, exponent: 1 };
  assert.ok(Math.abs(polyFeeRate(0.5, sched) - 0.0125) < 1e-12);
  assert.ok(Math.abs(polyCost(0.5, 0, sched) - 0.50625) < 1e-12);
  assert.equal(polyCost(0.5, 0, null), 0.5);
});

test('Sunderland is not an "under" market (regression)', () => {
  const sp = { id: 'epl', outcomes: 3 };
  const mk = (name, ask, bid) => ({ id: name, question: name === 'Draw' ? 'Will Sunderland AFC vs. Chelsea FC end in a draw?' : `Will ${name} win on 2026-11-08?`,
    sportsMarketType: 'moneyline', groupItemTitle: name === 'Draw' ? 'Draw (Sunderland AFC vs. Chelsea FC)' : name,
    outcomes: '["Yes","No"]', clobTokenIds: '["y","n"]', bestAsk: ask, bestBid: bid });
  const g = parsePolyEvent({ id: 1, slug: 'epl-sun-che-2026-11-08', title: 'Sunderland AFC vs. Chelsea FC',
    markets: [mk('Sunderland AFC', 0.2, 0.19), mk('Draw', 0.25, 0.24), mk('Chelsea FC', 0.57, 0.56)] }, sp);
  assert.ok(g, 'parsed');
  assert.deepEqual(g.outcomes.map(o => o.name), ['Sunderland AFC', 'Draw', 'Chelsea FC']);
});

test('esports: gamma markets normalised to team order', () => {
  const d = demoEsports();
  const g = parseGammaEsports(d.gamma.cs2[0], { id: 'cs2' });
  assert.deepEqual(g.teams, ['TheMongolz', 'MOUZ']);
  const hcp = g.markets.find(m => m.type === 'hcp');
  assert.equal(hcp.key, 'hcp|result|1.5'); // MOUZ -1.5 => TheMongolz +1.5
  assert.ok(Math.abs(hcp.legs[0].ask - 0.64) < 1e-9 && hcp.legs[1].ask === 0.37);
  assert.ok(g.markets.some(m => m.key === 'ml|p1|0'));
  assert.ok(g.markets.some(m => m.key === 'total|result|2.5'));
});

test('esports: fixture matching detects swapped teams', () => {
  const d = demoEsports();
  const g = parseGammaEsports(d.gamma.cs2[0], { id: 'cs2' });
  const m = matchFixture(g, d.fixtures.cs2, { threshold: 0.62, timeTolerance: 6 });
  assert.equal(m.fixture.id, 'id17demo1');
  assert.equal(m.swap, true);
});

test('esports: oddspapi handicap sign follows participant 1 and the swap', () => {
  assert.equal(hcpForParticipant1(-1.5, 'home/-1.5'), -1.5);
  assert.equal(hcpForParticipant1(-1.5, 'home/+1.5'), 1.5);
  assert.equal(hcpForParticipant1(-1.5, '1628099962'), -1.5);
  const d = demoEsports();
  const lines = oddsPapiLines(d.odds.id17demo1, d.markets, true, {});
  const h = lines.get('hcp|result|1.5');
  assert.ok(h, 'swapped handicap key exists');
  // outcome 0 = TheMongolz +1.5 (participant 2 at OddsPapi)
  assert.deepEqual(h.quotes[0].map(q => q.price), [1.49, 1.47]);
  assert.deepEqual(h.quotes[1].map(q => q.price).sort(), [2.62, 2.95]);
  assert.equal(outcomeLabel('hcp', 1.5, 0), 'Ф1(+1.5)');
  assert.equal(outcomeLabel('hcp', 1.5, 1), 'Ф2(-1.5)');
});

test('esports: arbs on demo data', () => {
  const s = { ...DEFAULT_SETTINGS, minProfit: 0.1 };
  const d = demoEsports();
  const g = parseGammaEsports(d.gamma.cs2[0], { id: 'cs2' });
  const lines = oddsPapiLines(d.odds.id17demo1, d.markets, true, s);
  const { arbs, compared } = esportsArbs(g, lines, s);
  const keys = arbs.map(a => a.market.key);
  assert.ok(keys.includes('ml|result|0'));
  assert.ok(keys.includes('hcp|result|1.5'));
  assert.ok(keys.includes('ml|p1|0'));
  assert.ok(compared.length >= 4);
  for (const a of arbs) {
    assert.ok(a.legs.some(l => l.src === 'poly') && a.legs.some(l => l.src === 'book'));
    assert.ok(new Set(a.legs.map(l => l.set[0])).size === 2, 'legs cover both outcomes');
  }
  const ml = arbs.find(a => a.market.key === 'ml|result|0');
  const poly = ml.legs.find(l => l.src === 'poly'), book = ml.legs.find(l => l.src === 'book');
  assert.equal(poly.label, 'П1 (матч)'); // TheMongolz on Polymarket
  assert.equal(book.label, 'П2 (матч)'); // MOUZ at the bookmaker
  assert.equal(book.book, 'Winline');
});

import { isStale } from '../js/esports.js';
import { OddsPapi } from '../js/oddspapi.js';

test('stale bookmaker prices are skipped only when the filter is on', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  assert.equal(isStale('2026-11-08T11:00:00Z', 0, now), false);
  assert.equal(isStale('2026-11-08T11:00:00Z', 30, now), true);
  assert.equal(isStale('2026-11-08T11:45:00Z', 30, now), false);
  assert.equal(isStale(null, 30, now), false);
});

test('oddspapi diagnose: tolerant to wrappers, never leaks the key', async () => {
  const d = demoEsports();
  const key = 'SECRET123';
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(url);
    const path = new URL(url).pathname.replace('/v4/', '');
    const body = {
      account: { request_count: 5, request_limit: 250 },
      bookmakers: [{ slug: 'pinnacle' }, { slug: 'winline' }],
      markets: { data: Object.entries(d.markets).map(([id, m]) => ({ marketId: +id, sportId: 17, marketType: m.t, period: m.p, handicap: m.h, outcomes: m.o.map(([outcomeId, outcomeName]) => ({ outcomeId, outcomeName })) })) },
      fixtures: [{ fixtureId: 'id17demo1', sportId: 17, statusId: 0, startTime: new Date(Date.now() + 3600e3).toISOString(), participant1Name: 'MOUZ', participant2Name: 'The MongolZ' }],
      odds: [d.odds.id17demo1],
    }[path];
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const p = new OddsPapi(key);
    const report = await p.diagnose(17);
    assert.ok(report.includes('bookmakers (2)'));
    assert.ok(report.includes('markets for sport: 8'));
    assert.ok(report.includes('spreads|result|-1.5'));
    assert.ok(report.includes('"home/-1.5"'));
    assert.ok(!report.includes(key));
    assert.ok(calls.every(u => u.includes('apiKey=' + key)));
  } finally { globalThis.fetch = realFetch; }
});

import { fairProbs, valueBets, findMiddles, middleNumbers } from '../js/value.js';
import { lineEntries } from '../js/esports.js';

test('value: de-vig Pinnacle and EV of a better price', () => {
  const quotes = [
    { set: [0], src: 'book', bookKey: 'pinnacle', price: 1.58, q: 1 / 1.58 },
    { set: [1], src: 'book', bookKey: 'pinnacle', price: 2.55, q: 1 / 2.55 },
    { set: [1], src: 'poly', bookKey: 'polymarket', price: 0.36, q: 0.3641 },
  ];
  const f = fairProbs(2, quotes);
  assert.ok(Math.abs(f.probs[0] + f.probs[1] - 1) < 1e-12);
  const [v] = valueBets(2, quotes, { minEV: 2, kellyFraction: 0.25, bankroll: 1000 });
  assert.equal(v.quote.src, 'poly');
  assert.ok(Math.abs(v.evPct - (f.probs[1] / 0.3641 - 1) * 100) < 1e-9);
  assert.ok(v.stake > 0 && v.stake < 1000 * 0.25);
  assert.equal(valueBets(2, quotes.slice(1), {}).length, 0, 'no sharp line => nothing');
});

test('middles: over low line + under high line', () => {
  const n = middleNumbers(0.486, 1 / 1.9);
  assert.ok(n.singlePct < 0 && n.singlePct > -2);
  assert.ok(n.bothPct > 90);
  const entries = [
    { type: 'total', period: 'p1', line: 21.5, quotes: [[{ src: 'poly', book: 'Polymarket', q: 0.486, set: [0] }], []] },
    { type: 'total', period: 'p1', line: 23.5, quotes: [[], [{ src: 'book', book: 'GG.bet', q: 1 / 1.9, set: [1] }]] },
    { type: 'total', period: 'p1', line: 22, quotes: [[{ src: 'poly', q: 0.3, set: [0] }], [{ src: 'book', q: 0.3, set: [1] }]] }, // integer line: ignored
  ];
  const [m, ...rest] = findMiddles(entries, { maxLoss: 3 });
  assert.equal(rest.length, 0);
  assert.equal(m.width, 2);
  assert.deepEqual(m.legs.map(l => l.line), [21.5, 23.5]);
  // handicap: team0 +2.5 with team1 -1.5 is a middle, the reverse is not
  const h = findMiddles([
    { type: 'hcp', period: 'result', line: 2.5, quotes: [[{ src: 'poly', q: 0.45, set: [0] }], []] },
    { type: 'hcp', period: 'result', line: 1.5, quotes: [[], [{ src: 'book', q: 0.56, set: [1] }]] },
  ], { maxLoss: 3 });
  assert.equal(h.length, 1);
  assert.equal(h[0].width, 1);
});

test('demo esports produce value bets and a middle', () => {
  const s = { ...DEFAULT_SETTINGS };
  const d = demoEsports();
  const g = parseGammaEsports(d.gamma.cs2[0], { id: 'cs2' });
  const lines = oddsPapiLines(d.odds.id17demo1, d.markets, true, s);
  const entries = lineEntries(g, lines, s);
  const values = entries.flatMap(e => valueBets(2, [...e.quotes[0], ...e.quotes[1]], { minEV: 2 }));
  assert.ok(values.some(v => v.quote.src === 'poly' && v.quote.label === 'П1 (матч)'));
  const mids = findMiddles(entries, { maxLoss: 3 });
  assert.ok(mids.some(m => m.type === 'total' && m.period === 'p1' && m.legs[0].src === 'poly' && m.legs[1].book === 'GG.bet'));
});

import { makerPrice, makerArbs, coverArbs, bo3Covers } from '../js/structure.js';
import { closingFair, legClv, entryPnl as jPnl } from '../js/journal.js';

test('maker price: one tick above bid, or join bid on a 1-tick spread', () => {
  assert.equal(makerPrice({ ask: 0.40, bid: 0.36, tick: 0.01 }), 0.37);
  assert.equal(makerPrice({ ask: 0.36, bid: 0.35, tick: 0.01 }), 0.35);
  assert.equal(makerPrice({ ask: 0.4, bid: null }), null);
});

test('maker arbs: limit order turns a non-arb into an arb, no taker fee', () => {
  const quotes = [
    { set: [0], src: 'poly', price: 0.40, bid: 0.36, tick: 0.01, q: 0.403, fee: { rate: 0.05, exponent: 1 } },
    { set: [1], src: 'book', price: 1.65, q: 1 / 1.65 },
  ];
  const [a] = makerArbs(2, quotes, { minProfit: 0.5 });
  const poly = a.legs.find(l => l.maker);
  assert.equal(poly.price, 0.37);
  assert.equal(poly.q, 0.37);
  assert.ok(Math.abs(a.profitPct - (1 / (0.37 + 1 / 1.65) - 1) * 100) < 1e-9);
});

test('cover arbs: BO3 П1 + Ф2(+1.5) pays at least once, twice on 2:1', () => {
  const entries = [
    { key: 'ml|result|0', quotes: [[{ src: 'poly', q: 0.45, mkey: 'ml|result|0', set: [0] }], []] },
    { key: 'hcp|result|-1.5', quotes: [[], [{ src: 'book', q: 0.50, mkey: 'hcp|result|-1.5', set: [1] }]] },
  ];
  const [c] = bo3Covers(entries, { minProfit: 0 });
  assert.equal(c.legs.length, 2);
  assert.equal(c.minCover, 1);
  assert.deepEqual(c.counts, [1, 2, 1, 1]); // 2:0, 2:1, 1:2, 0:2
  assert.ok(Math.abs(c.profitPct - (1 / 0.95 - 1) * 100) < 1e-9);
  assert.ok(c.maxPct > 100);
  // same-market pairs are ordinary arbs, not covers
  assert.equal(coverArbs(2, [{ covers: [0], q: 0.4, src: 'poly', mkey: 'a' }, { covers: [1], q: 0.5, src: 'book', mkey: 'a' }]).length, 0);
});

test('CLV: closing fair odds from history, last price before start', () => {
  const start = Date.parse('2026-11-08T18:00:00Z');
  const hist = { bookmakers: { pinnacle: { markets: { 171: { outcomes: {
    171: { players: { 0: [{ createdAt: '2026-11-08T17:59:00Z', price: 1.50 }, { createdAt: '2026-11-08T18:30:00Z', price: 1.10 }, { createdAt: '2026-11-08T12:00:00Z', price: 1.60 }] } },
    172: { players: { 0: [{ createdAt: '2026-11-08T17:58:00Z', price: 2.70 }] } },
  } } } } } };
  const fair = closingFair(hist, 'pinnacle', 171, 172, start);
  const p2 = (1 / 2.7) / (1 / 1.5 + 1 / 2.7);
  assert.ok(Math.abs(fair - 1 / p2) < 1e-9);
  assert.ok(Math.abs(legClv({ price: 3.0, closeFair: fair }) - (3 / fair - 1) * 100) < 1e-9);
  assert.equal(closingFair(hist, 'pinnacle', 999, 172, start), null);
});

test('journal: lost and multi-win statuses', () => {
  const e = { legs: [{ stake: 50, price: 2.2 }, { stake: 50, price: 2.0 }] };
  assert.equal(jPnl({ ...e, status: 'lost' }).pnl, -100);
  assert.ok(Math.abs(jPnl({ ...e, status: [0, 1] }).pnl - 110) < 1e-9);
  assert.ok(Math.abs(jPnl({ ...e, status: '1' }).pnl - 0) < 1e-9);
});
