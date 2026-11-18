import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resultFromMarket, entryPnl, entryClv, journalStats, toCSV, arbEntry, valueEntry } from '../js/journal.js';

const { markets } = JSON.parse(readFileSync(new URL('./fixtures/resolved.json', import.meta.url)));
const balkan = markets['7062943'], forze = markets['7075600'];
const tok = m => JSON.parse(m.clobTokenIds);

const arb = (token, extra = {}) => ({
  kind: 'arb', token, marketId: '7062943', title: 'Balkan Outlaws vs WRAITH PCIFIC', label: 'Победа в матче', ts: 0, start: 0,
  poly: { side: 'Balkan Outlaws', price: 0.4, shares: 102, usd: 41.5 }, duel: { side: 'WRAITH PCIFIC', label: 'WRAITH PCIFIC', odds: 1.75, stake: 58.3 },
  result: null, ...extra,
});

test('settled from the real Polymarket resolution (Balkan Outlaws won 1/0)', () => {
  const [balkanTok, wraithTok] = tok(balkan);
  assert.equal(resultFromMarket(arb(balkanTok), balkan), 'poly');   // we held Balkan on Polymarket
  assert.equal(resultFromMarket(arb(wraithTok), balkan), 'duel');   // we held WRAITH on Polymarket -> Duel leg won
  const v = { kind: 'value', token: wraithTok, duel: { odds: 2.6, stake: 20 } };
  assert.equal(resultFromMarket(v, balkan), 'lost');                 // Duel bet on WRAITH
  assert.equal(resultFromMarket({ ...v, token: balkanTok }, balkan), 'won');
  // not resolved yet
  assert.equal(resultFromMarket(arb(tok(forze)[0]), forze), null);
  // a 50-50 resolution needs a look by hand
  assert.equal(resultFromMarket(arb(balkanTok), { ...balkan, outcomePrices: '["0.5","0.5"]' }), 'half');
  // a token from another market is not settled by mistake
  assert.equal(resultFromMarket(arb(tok(forze)[0]), balkan), null);
});

test('profit of an arb on each outcome, and partial refunds', () => {
  const e = arb('t');
  const total = 41.5 + 58.3;
  assert.ok(Math.abs(entryPnl({ ...e, result: 'poly' }) - (102 - total)) < 1e-9);
  assert.ok(Math.abs(entryPnl({ ...e, result: 'duel' }) - (58.3 * 1.75 - total)) < 1e-9);
  assert.ok(Math.abs(entryPnl({ ...e, result: 'duel-void-poly-won' }) - (102 - 41.5)) < 1e-9);
  assert.equal(entryPnl({ ...e, result: 'duel-void-poly-lost' }), -41.5);
  assert.equal(entryPnl({ ...e, result: 'void' }), 0);
  assert.equal(entryPnl({ ...e, result: null }), null);
  assert.equal(entryPnl({ ...e, result: 'half' }), null);
});

test('value bets: profit, CLV against the fair line at the start, stats', () => {
  const v = { kind: 'value', duel: { odds: 2.6, stake: 20, label: 'x' }, poly: null, close: { fairP: 0.42 }, result: 'won', ts: 0, start: 0, title: 't', label: 'l' };
  assert.ok(Math.abs(entryPnl(v) - 32) < 1e-9);
  assert.ok(Math.abs(entryClv(v) - (2.6 * 0.42 - 1) * 100) < 1e-9); // +9.2%
  const lost = { ...v, result: 'lost', close: { fairP: 0.35 } };
  const st = journalStats([v, lost, { ...v, result: null }, { ...arb('t'), result: 'poly' }]);
  assert.equal(st.value.count, 3);
  assert.equal(st.value.open, 1);
  assert.ok(Math.abs(st.value.pnl - (32 - 20)) < 1e-9);
  assert.ok(Math.abs(st.value.roi - 12 / 40 * 100) < 1e-9);
  assert.equal(st.arb.settled, 1);
  const csv = toCSV([v]);
  assert.match(csv.split('\n')[1], /валуйка/);
});

test('entries keep the token of the right side', () => {
  const pm = { outs: [{ token: 'A', marketId: 'm' }, { token: 'B', marketId: 'm' }], key: 'win|match|maps|0' };
  const row = { poly: { title: 't', start: new Date(0), id: 'p', url: 'u', sport: 'cs2' }, duel: { url: 'd' }, label: 'l', market: pm, pi: 0, pSide: 'A', dSide: 'B',
    polyLeg: { token: 'A', marketId: 'm', price: 0.3 }, duelLeg: { label: 'B', price: 1.6 }, polyShares: 10, polyUsd: 3.1, duelStake: 6.25 };
  const a = arbEntry(row);
  assert.equal(a.token, 'A'); assert.equal(a.duelIdx, 1); assert.equal(a.tokenIsDuelSide, false);
  const v = valueEntry({ poly: row.poly, duel: row.duel, label: 'l', market: pm, i: 1, side: 'B', duelLeg: { label: 'B', price: 2.9 }, stake: 12, p: 0.4 });
  assert.equal(v.token, 'B'); assert.equal(v.duelIdx, 1); assert.equal(v.duel.stake, 12);
});
