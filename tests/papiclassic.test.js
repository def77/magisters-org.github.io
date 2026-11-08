import test from 'node:test';
import assert from 'node:assert/strict';
import { isCryptoBook, cryptoSlugs, papiResultBooks, papiEvent, mergePapiEvent } from '../js/papiclassic.js';
import { scan } from '../js/scanner.js';
import { DEFAULT_SETTINGS } from '../js/config.js';

const pl = (price, extra = {}) => ({ players: { 0: { price, active: true, ...extra } } });
const markets1x2 = { 101: { t: 'moneyline', p: 'fulltime', h: 0, o: [[1, '1'], [2, 'X'], [3, '2']] } };
const fixture = { id: 'F1', start: new Date('2026-11-08T15:00:00Z'), names: [['Arsenal FC', 'Arsenal'], ['Chelsea FC', 'Chelsea']], title: 'Arsenal FC vs Chelsea FC' };
const odds1x2 = { bookmakerOdds: {
  stake: { markets: { 101: { outcomes: { 1: pl(2.6, { limit: 500 }), 2: pl(3.5), 3: pl(2.9) } } }, fixturePath: 'https://stake.com/x' },
  pinnacle: { markets: { 101: { outcomes: { 1: pl(2.5), 2: pl(3.4), 3: pl(2.8) } } } },
  polymarket: { markets: { 101: { outcomes: { 1: pl(2.7), 2: pl(3.6), 3: pl(3.0) } } } },
  dead: { suspended: true, markets: { 101: { outcomes: { 1: pl(9), 2: pl(9), 3: pl(9) } } } },
} };

test('crypto book detection', () => {
  for (const k of ['stake', 'duel', 'bcgame', 'bc.game', 'roobet', 'cloudbet', 'sportsbet.io', 'thunderpick']) assert.ok(isCryptoBook(k), k);
  for (const k of ['pinnacle', 'bet365', 'betfair-ex', 'mistake-free', 'stakeholder']) assert.ok(!isCryptoBook(k), k);
  assert.deepEqual(cryptoSlugs([{ slug: 'pinnacle' }, { slug: 'stake' }, { slug: 'xyz', name: 'Duel' }]), ['stake', 'xyz']);
});

test('OddsPapi 1X2 -> books keyed by team names', () => {
  const books = papiResultBooks(odds1x2, markets1x2, 3, ['Arsenal FC', 'Chelsea FC']);
  assert.deepEqual(books.map(b => b.key).sort(), ['pinnacle', 'stake']);
  const st = books.find(b => b.key === 'stake');
  assert.deepEqual(st.prices, { 'Arsenal FC': 2.6, Draw: 3.5, 'Chelsea FC': 2.9 });
  assert.equal(st.limits['Arsenal FC'], 500);
  assert.equal(st.title, 'Stake');
  assert.ok(st.papi);
  assert.deepEqual(papiResultBooks(odds1x2, markets1x2, 3, ['A', 'B'], { oddspapiBooks: 'stake' }).map(b => b.key), ['stake']);
  assert.equal(papiResultBooks(odds1x2, markets1x2, 2, ['A', 'B']).length, 0); // 3-way market is not a moneyline
});

test('OddsPapi books merge into The Odds API event or join the pool', () => {
  const ev = papiEvent(fixture, papiResultBooks(odds1x2, markets1x2, 3, ['Arsenal FC', 'Chelsea FC']), 3);
  const pool = [{ id: 'oa', start: fixture.start, outcomeNames: ['Arsenal', 'Draw', 'Chelsea'], books: [{ key: 'pinnacle', title: 'Pinnacle', prices: { Arsenal: 2.4, Draw: 3.3, Chelsea: 2.7 } }] }];
  assert.equal(mergePapiEvent(pool, ev), 'merged');
  assert.equal(pool.length, 1);
  assert.deepEqual(pool[0].books.map(b => b.key), ['pinnacle', 'stake']); // pinnacle from The Odds API is kept
  assert.deepEqual(pool[0].books[1].prices, { Arsenal: 2.6, Draw: 3.5, Chelsea: 2.9 });
  const empty = [];
  assert.equal(mergePapiEvent(empty, ev), 'added');
  assert.equal(empty[0].id, 'papi:F1');
});

test('crypto book quote reaches the arb finder despite The Odds API whitelist', () => {
  const books = papiResultBooks(odds1x2, markets1x2, 3, ['Arsenal FC', 'Chelsea FC']);
  const pool = [];
  mergePapiEvent(pool, papiEvent(fixture, books, 3));
  const yes = ask => ({ ask, bid: null, tick: 0.01, token: 't' + ask, fee: null });
  const game = { id: 'g', sport: 'epl', start: fixture.start, url: 'u', outcomes: [
    { name: 'Arsenal', yes: yes(0.30), no: yes(0.75) }, { name: 'Draw', yes: yes(0.30), no: yes(0.75) }, { name: 'Chelsea', yes: yes(0.36), no: yes(0.66) }] };
  const s = { ...DEFAULT_SETTINGS, bookmakers: 'pinnacle', minProfit: 0 };
  const { matches } = scan([game], { epl: pool }, s);
  assert.equal(matches.length, 1);
  const q = matches[0].quotes.find(x => x.bookKey === 'stake' && x.out === 0);
  assert.ok(q, 'stake quote present');
  assert.equal(q.limit, 500);
  assert.equal(q.url, 'https://stake.com/x');
});
