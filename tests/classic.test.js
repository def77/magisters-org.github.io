// Classic sports on real responses saved on 2026-11-18 (tests/fixtures/*-classic.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePolyEvent, parseDuelEvent, duelEventStub, mergePolyGames, isVirtual } from '../js/markets.js';
import { matchGames, comparePair, toPolyFrame } from '../js/compare.js';
import { teamScore } from '../js/names.js';

const fx = f => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const gamma = fx('gamma-classic.json'), duel = fx('duel-classic.json');
const NOW = Date.parse('2026-11-18T12:00:00Z');
const poly = (list, profile) => mergePolyGames(list.map(e => parsePolyEvent(e, { id: profile, profile }, NOW)).filter(g => !g.skip && g.markets.size));
const pairOf = (p, d) => { const { pairs } = matchGames([p], [d]); assert.equal(pairs.length, 1, 'matched'); return { ...pairs[0], duel: d }; };
/** Every comparison must bet the two opposite sides of one market — checked on the Duel label too. */
function checkOpposite(rows, teams, duelTeams) {
  for (const r of rows) {
    assert.notEqual(r.pSide, r.dSide);
    const k = r.market.kind;
    if (k === 'total') assert.deepEqual([r.pSide.split(' ')[0], r.dSide.split(' ')[0]].sort(), ['Больше', 'Меньше']);
    if (k === 'win' || k === 'hcp') {
      const pTeam = teams.find(t => r.pSide.startsWith(t)), dTeam = teams.find(t => r.dSide.startsWith(t));
      assert.ok(pTeam && dTeam && pTeam !== dTeam, `${r.pSide} / ${r.dSide}`);
      const duelName = duelTeams.find(t => r.duelLeg.label.startsWith(t));
      assert.ok(teamScore(duelName, dTeam) >= 0.85, `Duel "${r.duelLeg.label}" is not ${dTeam}`);
    }
  }
}

test('football: one game from several Polymarket events, three-way result as Yes/No', () => {
  const [g] = poly(gamma.epl, 'soccer');
  assert.deepEqual(g.teams, ['Manchester City FC', 'Fulham FC']);
  assert.equal(g.slug, 'epl-mac-ful-2026-11-21'); // the main event gives the link
  for (const x of [0, 1, 2]) assert.ok(g.markets.has(`x|match|goals|${x}`));
  assert.equal(g.markets.get('x|match|goals|1').outs[0].label, 'Ничья');
  assert.ok(g.markets.has('total|match|goals|2.5') && g.markets.has('hcp|match|goals|-1.5'));
});

test('football: Duel 1x2 + double chance give "happens / does not" for each result', () => {
  const d = parseDuelEvent(duel.soccer, NOW, 'soccer');
  const home = d.markets.get('x|match|goals|0'), draw = d.markets.get('x|match|goals|1');
  assert.equal(home.outs[0].label, 'Manchester City');
  assert.equal(home.outs[1].label, 'draw or Fulham FC');
  assert.equal(draw.outs[0].label, 'draw');
  assert.equal(draw.outs[1].label, 'Manchester City or Fulham FC');
  // reversed teams: team 0 <-> team 1, the draw stays
  assert.equal(toPolyFrame(home, [1, 0]).key, 'x|match|goals|2');
  assert.equal(toPolyFrame(draw, [1, 0]).key, 'x|match|goals|1');
});

test('football: comparisons pair "Man City wins" only with "Man City does not win"', () => {
  const [g] = poly(gamma.epl, 'soccer');
  const pair = pairOf(g, parseDuelEvent(duel.soccer, NOW, 'soccer'));
  const rows = comparePair(pair, new Map(), { maxAgeMin: 0 });
  const x = rows.filter(r => r.market.kind === 'x');
  assert.equal(x.length, 6);
  for (const r of x) {
    const yes = r.pi === 0; // Polymarket YES side: the result happens
    assert.equal(r.duelLeg.label.includes(' or '), yes, `${r.pSide} + ${r.duelLeg.label}`);
  }
  checkOpposite(rows.filter(r => r.market.kind !== 'x'), g.teams, ['Manchester City', 'Fulham FC']);
});

test('NBA: "Grizzlies" = "Memphis Grizzlies", reversed home/away, overtime markets only', () => {
  const [g] = poly(gamma.nba, 'basketball');
  const d = parseDuelEvent(duel.basketball, NOW, 'basketball');
  assert.ok(d.markets.has('win|match|-|0'));
  const pair = pairOf(g, d);
  assert.deepEqual(pair.perm, [1, 0]);
  const rows = comparePair(pair, new Map(), { maxAgeMin: 0 });
  assert.ok(new Set(rows.map(r => r.market.key)).size > 10);
  checkOpposite(rows, g.teams, d.teams);
});

test('NHL: only Duel markets including overtime and shootout are used', () => {
  const d = parseDuelEvent(duel.ice_hockey, NOW, 'hockey');
  // m_1 (60-minute 1x2) is in the fixture but must not become a market
  assert.ok([...d.markets.values()].every(m => /^m_41[02]|^m_406/.test(m.duelKey)));
  const [g] = poly(gamma.nhl, 'hockey');
  const pair = pairOf(g, d);
  checkOpposite(comparePair(pair, new Map(), { maxAgeMin: 0 }), g.teams, d.teams);
});

test('tennis: "Zverev, Alexander" = "Alexander Zverev", sets and games', () => {
  assert.equal(teamScore('Zverev, Alexander', 'Alexander Zverev'), 1);
  const [g] = poly(gamma.atp, 'tennis');
  const d = parseDuelEvent(duel.tennis, NOW, 'tennis');
  for (const k of ['win|match|-|0', 'win|set1|-|0', 'total|match|sets|2.5', 'hcp|match|sets|-1.5']) assert.ok(d.markets.has(k), k);
  const pair = pairOf(g, d);
  const rows = comparePair(pair, new Map(), { maxAgeMin: 0 });
  assert.ok(rows.some(r => r.market.key === 'win|set1|-|0'));
  checkOpposite(rows, g.teams, d.teams);
});

test('Duel simulated games are never matched', () => {
  const virt = [...duel.stubs_basketball, ...duel.stubs_hockey].filter(e => /\(E\)|3x3/.test(`${e.home_team} ${e.tournament}`));
  assert.ok(virt.length > 3);
  for (const e of virt) { assert.ok(isVirtual(e), e.tournament); assert.equal(duelEventStub(e, 0), null); }
  assert.equal(isVirtual({ home_team: 'Toronto Raptors (E)', away_team: 'Memphis Grizzlies (E)', tournament: 'NBA (24 min play)' }), true);
  assert.equal(isVirtual({ home_team: 'Toronto Raptors', away_team: 'Washington Wizards', tournament: 'NBA' }), false);
  // a real Polymarket NBA game is matched with the real Duel game, not a simulated one
  const [g] = poly(gamma.nba, 'basketball');
  const stubs = duel.stubs_basketball.map(e => duelEventStub(e, NOW)).filter(Boolean);
  const fake = { ...stubs[0], id: 'v', teams: ['Cleveland Cavaliers (E)', 'Memphis Grizzlies (E)'], start: g.start };
  const { pairs } = matchGames([g], [...stubs, fake].filter(s => !isVirtual({ home_team: s.teams[0], away_team: s.teams[1], tournament: s.tournament })));
  assert.equal(pairs[0].duel.title, 'Cleveland Cavaliers vs Memphis Grizzlies');
});
