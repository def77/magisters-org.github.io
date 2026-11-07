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
  const books = demoBooks(arbs.flatMap(a => a.legs.map(l => l.token)), poly);
  for (const a of arbs) {
    applyDepth(a, books, s);
    assert.ok(a.maxBankroll > 0);
  }
});

test('gamma parser: moneyline without sportsMarketType, skips futures', () => {
  const sp = DEFAULT_SPORTS[0];
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
