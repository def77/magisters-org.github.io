import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePolyEvent, parseDuelEvent } from '../js/markets.js';
import { matchGames, valueBets, fairFromBooks, comparePair } from '../js/compare.js';

const fx = f => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const gamma = fx('gamma.json').series, duel = fx('duel.json'), raw = fx('books.json').books;
const BEFORE = Date.parse('2026-11-18T11:00:00Z');
const books = new Map(raw.map(b => [b.asset_id, { asks: b.asks, bids: b.bids }]));
const setup = () => {
  const p = parsePolyEvent(gamma['10310'].find(e => e.title.includes('FORZE Reload')), 'cs2', BEFORE);
  const d = parseDuelEvent(duel.event_forze, BEFORE);
  return { p, d, pair: matchGames([p], [d]).pairs[0] };
};

test('fair line = middle of the Polymarket book, both tokens agree', () => {
  const { p } = setup();
  const ml = p.markets.get('win|match|maps|0');
  const f = fairFromBooks(ml, books);
  const best = (t, side, fn) => fn(...books.get(t)[side].map(l => +l.price));
  const mid0 = (best(ml.outs[0].token, 'asks', Math.min) + best(ml.outs[0].token, 'bids', Math.max)) / 2;
  const mid1 = (best(ml.outs[1].token, 'asks', Math.min) + best(ml.outs[1].token, 'bids', Math.max)) / 2;
  assert.ok(Math.abs(f.p[0] - (mid0 + 1 - mid1) / 2) < 1e-12);
  assert.ok(Math.abs(f.p[0] + f.p[1] - 1) < 1e-12);
  assert.ok(f.p[0] > 0.6 && f.p[0] < 0.9, `FORZE Reload is the favourite: ${f.p[0]}`);
  assert.ok(f.quote[1].bid < f.quote[1].ask);
});

test('value rows: EV = fair probability x Duel odds - 1, on the right team', () => {
  const { pair } = setup();
  const rows = valueBets(pair, books, { maxAgeMin: 0, minEV: 3 }, BEFORE);
  assert.ok(rows.length >= 6);
  for (const r of rows.filter(r => r.fair)) {
    assert.ok(Math.abs(r.ev - (r.p * r.duelLeg.price - 1)) < 1e-12);
    if (r.market.kind !== 'total') assert.ok(r.duelLeg.label.startsWith(r.side.replace(/ [+−][\d.]+$/, '')), `${r.duelLeg.label} / ${r.side}`);
  }
  const g2 = rows.find(r => r.market.key === 'win|match|maps|0' && r.side === 'G2 Ares');
  assert.equal(g2.duelLeg.price, 3.85);
  assert.equal(g2.duelLeg.open, 3.8); // line moved up from 3.80
  assert.equal(g2.duelLeg.move, 0.05);
});

test('a Duel price above the fair line becomes a value bet with a Kelly stake', () => {
  const { pair } = setup();
  const ml = pair.duel.markets.get('win|match|maps|0');
  ml.outs[1].price = 5.0; // G2 Ares on Duel
  const s = { maxAgeMin: 0, minEV: 3, valueBank: 1000, kellyFraction: 0.25 };
  const v = valueBets(pair, books, s, BEFORE).find(r => r.market.key === 'win|match|maps|0' && r.side === 'G2 Ares');
  assert.ok(v.value, `EV ${v.evPct}`);
  const k = (v.p * 5 - 1) / 4;
  assert.ok(Math.abs(v.stake - 1000 * 0.25 * k) < 1e-9);
  // the other side is not a value bet
  const f = valueBets(pair, books, s, BEFORE).find(r => r.market.key === 'win|match|maps|0' && r.side === 'FORZE Reload');
  assert.equal(f.value, false);
});

test('wide spread and stale market are not value bets', () => {
  const { pair, p } = setup();
  const ml = p.markets.get('win|match|maps|0');
  const wide = new Map(books);
  wide.set(ml.outs[0].token, { asks: [{ price: '0.90', size: '10' }], bids: [{ price: '0.60', size: '10' }] });
  wide.set(ml.outs[1].token, { asks: [{ price: '0.40', size: '10' }], bids: [{ price: '0.10', size: '10' }] });
  pair.duel.markets.get('win|match|maps|0').outs[1].price = 9;
  const r = valueBets(pair, wide, { maxAgeMin: 0, minEV: 3 }, BEFORE).find(x => x.market.key === ml.key && x.side === 'G2 Ares');
  assert.equal(r.value, false);
  assert.match(r.problems.join(), /спред/);
  // each Duel market has its own update time: 11:27:41 for the match winner
  const late = Date.parse('2026-11-18T11:40:00Z');
  const r2 = valueBets(pair, books, { maxAgeMin: 10, minEV: 3 }, late).find(x => x.market.key === ml.key && x.side === 'G2 Ares');
  assert.match(r2.problems.join(), /старше 10 мин/);
  const arb = comparePair(pair, books, { maxAgeMin: 10 }, late).find(x => x.market.key === ml.key);
  assert.match(arb.problems.join(), /старше 10 мин/);
});
