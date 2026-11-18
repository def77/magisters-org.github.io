// Tests on real API responses saved on 2026-11-18 (tests/fixtures).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { teamScore } from '../js/names.js';
import { parsePolyEvent, parseDuelEvent, duelEventStub, splitLine } from '../js/markets.js';
import { matchGames, comparePair, polyCost, polyFee, toPolyFrame } from '../js/compare.js';

const fx = f => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const gamma = fx('gamma.json').series, duel = fx('duel.json'), books = fx('books.json').books;
const BEFORE = Date.parse('2026-11-18T11:00:00Z'); // the moment the fixtures were "live"
const polyEv = (s, part) => gamma[s].find(e => e.title.includes(part));
const bookMap = new Map(books.map(b => [b.asset_id, b.asks]));

test('academies and second rosters are different teams', () => {
  assert.equal(teamScore('FORZE Reload', 'FORZE'), 0);
  assert.equal(teamScore('G2 Ares', 'G2 Esports'), 0);
  assert.equal(teamScore('Team Spirit Academy', 'Team Spirit'), 0);
  assert.equal(teamScore('Spirit Academy', 'Team Spirit'), 0);
  assert.equal(teamScore('mouz NXT', 'MOUZ'), 0);
  assert.equal(teamScore('Vitality Academy', 'Team Vitality'), 0);
});

test('same team, different spelling', () => {
  assert.equal(teamScore('Aurora', 'Aurora Gaming'), 1);
  assert.equal(teamScore('angry birds', 'Angry Birds'), 1);
  assert.equal(teamScore('Team Spirit', 'Spirit'), 1);
  assert.equal(teamScore('Infurity Gaming', 'INFURITY Gaming'), 1);
  assert.ok(teamScore('ex-RUSTEC', 'exRUSTEC') >= 0.98);
  assert.equal(teamScore('NAVI', 'Natus Vincere'), 1);
  assert.equal(teamScore('FORZE Reload', 'G2 Ares'), 0);
});

test('Polymarket: map handicap sign follows the team, not the outcome order', () => {
  const g = parsePolyEvent(polyEv('10310', 'FORZE Reload'), 'cs2', BEFORE);
  assert.deepEqual(g.teams, ['FORZE Reload', 'G2 Ares']);
  const hcp = g.markets.get('hcp|match|maps|-1.5'); // FORZE -1.5
  assert.ok(hcp, 'map handicap present');
  assert.equal(hcp.outs[0].label, 'FORZE Reload −1.5');
  assert.equal(hcp.outs[1].label, 'G2 Ares +1.5');
  assert.ok(g.markets.get('win|match|maps|0') && g.markets.get('win|map1|maps|0') && g.markets.get('total|match|maps|2.5'));
  // Balkan vs WRAITH: two handicap markets written from opposite sides
  const b = parsePolyEvent(polyEv('10310', 'Balkan Outlaws'), 'cs2', Date.parse('2026-11-18T09:00:00Z'));
  assert.deepEqual(b.teams, ['Balkan Outlaws', 'WRAITH PCIFIC']);
  assert.ok(b.markets.has('hcp|match|maps|1.5') && b.markets.has('hcp|match|maps|-1.5'));
  assert.equal(b.markets.get('hcp|match|maps|1.5').outs[0].label, 'Balkan Outlaws +1.5'); // "PCIFIC (-1.5) vs Balkan (+1.5)"
});

test('Polymarket: started matches are skipped', () => {
  const r = parsePolyEvent(polyEv('10310', 'Balkan Outlaws'), 'cs2', BEFORE);
  assert.equal(r.skip, 'матч уже начался');
});

test('Polymarket: round handicap of map 1', () => {
  const g = parsePolyEvent(polyEv('10310', 'BOJONG'), 'cs2', Date.parse('2026-11-01T00:00:00Z'));
  const m = [...g.markets.values()].find(x => x.kind === 'hcp' && x.unit === 'rounds');
  assert.ok(m);
  // "Younglings (-3.5) vs BOJONG (+3.5)", teams [BOJONG, Younglings] -> BOJONG +3.5
  assert.equal(m.key, 'hcp|map1|rounds|3.5');
  assert.equal(m.outs[0].label, 'BOJONG +3.5');
});

test('Duel: names, lines and filters', () => {
  assert.deepEqual(splitLine('G2 Ares (+1.5)'), { name: 'G2 Ares', line: 1.5 });
  const d = parseDuelEvent(duel.event_forze, BEFORE);
  assert.deepEqual(d.teams, ['FORZE Reload', 'G2 Ares']);
  const hcp = d.markets.get('hcp|match|maps|-1.5');
  assert.equal(hcp.outs[0].price, 2.02); // FORZE Reload (-1.5)
  assert.equal(hcp.outs[1].price, 1.79); // G2 Ares (+1.5)
  assert.equal(d.markets.get('win|match|maps|0').outs[1].price, 3.85);
  assert.equal(d.markets.get('total|match|maps|2.5').outs[0].price, 2.18); // over
  // matches already being played come with live:false but a running status
  const [perfecto, rooster, nicetry, outright] = duel.cs_odds_live_and_outright;
  assert.match(parseDuelEvent(perfecto, BEFORE).skip, /идёт/);
  assert.match(parseDuelEvent(nicetry, BEFORE).skip, /идёт/);
  assert.equal(parseDuelEvent(outright, Date.parse('2026-11-18T09:00:00Z')).skip, 'нет рынков на две команды (аутрайт или пусто)');
  assert.ok(rooster);
});

test('matching: FORZE Reload vs G2 Ares finds its own game, not FORZE or G2', () => {
  const poly = [parsePolyEvent(polyEv('10310', 'FORZE Reload'), 'cs2', BEFORE)];
  const stubs = duel.cs_events.map(e => duelEventStub(e, BEFORE)).filter(Boolean);
  const fakeMain = { ...stubs.find(s => s.title.includes('FORZE')), id: 'x', teams: ['FORZE', 'G2 Esports'] };
  const { pairs, doubt } = matchGames(poly, [...stubs, fakeMain]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].duel.title, 'FORZE Reload vs G2 Ares');
  assert.equal(doubt.length, 0);
});

test('matching: reversed home/away and "Aurora" = "Aurora Gaming"', () => {
  const poly = [parsePolyEvent(polyEv('10309', 'Aurora vs PARIVISION'), 'dota2', BEFORE)];
  const d = parseDuelEvent(duel.dota_odds[0], BEFORE);
  const { pairs } = matchGames(poly, [d]);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].perm, [1, 0]);
  // Duel "PARIVISION (-1.5)" is Polymarket team 1, so in Polymarket order team 0 (Aurora) is +1.5
  const dm = toPolyFrame(d.markets.get('hcp|match|maps|-1.5'), pairs[0].perm);
  assert.equal(dm.key, 'hcp|match|maps|1.5');
  assert.equal(dm.outs[0].label, 'Aurora Gaming (+1.5)');
  assert.equal(dm.outs[1].label, 'PARIVISION (-1.5)');
});

test('Polymarket fee: $1.25 per 100 shares at 0.50 for sports', () => {
  const fee = { rate: 0.05, exponent: 1 };
  assert.ok(Math.abs(polyFee(0.5, fee) * 100 - 1.25) < 1e-9);
  assert.ok(Math.abs(polyCost(0.5, fee) - 0.5125) < 1e-9);
});

test('every compared pair is two opposite sides of the same market', () => {
  const p = parsePolyEvent(polyEv('10310', 'FORZE Reload'), 'cs2', BEFORE);
  const d = parseDuelEvent(duel.event_forze, BEFORE);
  const { pairs } = matchGames([p], [d]);
  const rows = comparePair(pairs[0], bookMap, { maxAgeMin: 0 }, BEFORE);
  assert.ok(rows.length >= 6);
  for (const r of rows) {
    assert.notEqual(r.pSide, r.dSide);
    if (r.market.kind === 'win') assert.deepEqual([r.pSide, r.dSide].sort(), [...p.teams].sort());
    if (r.market.kind === 'total') assert.deepEqual([r.pSide.split(' ')[0], r.dSide.split(' ')[0]].sort(), ['Больше', 'Меньше']);
    // Duel's own outcome name must be the side we bet there
    const team = r.dSide.replace(/ [+−][\d.]+$/, '');
    if (r.market.kind !== 'total') assert.ok(r.duelLeg.label.startsWith(team), `${r.duelLeg.label} vs ${r.dSide}`);
  }
  // real prices that day: no arb
  assert.equal(rows.filter(r => r.arb).length, 0);
  const ml = rows.find(r => r.market.key === 'win|match|maps|0' && r.pSide === 'G2 Ares');
  assert.equal(ml.duelLeg.price, 1.26); // FORZE Reload on Duel
});

test('a real arb is found and sized; a near-resolved price is not an arb', () => {
  const p = parsePolyEvent(polyEv('10310', 'FORZE Reload'), 'cs2', BEFORE);
  const d = parseDuelEvent(duel.event_forze, BEFORE);
  const { pairs } = matchGames([p], [d]);
  const ml = p.markets.get('win|match|maps|0');
  const cheap = new Map(bookMap);
  cheap.set(ml.outs[1].token, [{ price: '0.18', size: '50' }, { price: '0.25', size: '100' }]); // G2 Ares YES at 0.18
  const rows = comparePair(pairs[0], cheap, { bankroll: 100, minProfit: 0 }, BEFORE);
  const a = rows.find(r => r.arb);
  assert.ok(a, 'arb found');
  assert.equal(a.pSide, 'G2 Ares');
  assert.equal(a.dSide, 'FORZE Reload');
  assert.equal(a.duelLeg.label, 'FORZE Reload');
  const q = polyCost(0.18, ml.outs[1].fee) + 1 / 1.26;
  assert.ok(Math.abs(a.sum - q) < 1e-9);
  assert.ok(Math.abs(a.polyUsd + a.duelStake - 100) < 1e-9);
  assert.ok(Math.abs(a.polyShares - a.duelStake * 1.26) < 1e-9); // same payout either way
  assert.equal(a.maxShares, 50); // the 0.25 level is not an arb any more
  cheap.set(ml.outs[1].token, [{ price: '0.01', size: '500' }]);
  const r2 = comparePair(pairs[0], cheap, {}, BEFORE).find(r => r.market.key === ml.key && r.pSide === 'G2 Ares');
  assert.equal(r2.arb, false);
  assert.match(r2.problems[0], /почти решён/);
});
