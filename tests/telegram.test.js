import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAlert, markAlerted, arbMessage, valueMessage, linkButtons, sendTelegram, findChatId } from '../js/telegram.js';

const M = 60e3;

test('each arb once; again only when it got better or an hour passed', () => {
  const map = new Map();
  assert.equal(shouldAlert(map, 'a', 1.5, 0), true);
  markAlerted(map, 'a', 1.5, 0);
  assert.equal(shouldAlert(map, 'a', 1.6, 5 * M), false);      // same arb, tiny change
  assert.equal(shouldAlert(map, 'a', 2.6, 5 * M), true);       // +1.1 points
  assert.equal(shouldAlert(map, 'a', 1.5, 61 * M), true);      // an hour later
  assert.equal(shouldAlert(map, 'b', 0.8, 5 * M), true);       // another arb
});

const row = {
  profitPct: 1.93, suspicious: false, label: 'Победа в матче', pSide: 'G2 Ares', polyShares: 101.9, polyUsd: 19.1, profitUsd: 1.93, maxBank: 39.24,
  poly: { title: 'FORZE Reload vs G2 Ares', start: new Date('2026-11-18T15:00:00Z'), url: 'https://polymarket.com/event/x' },
  duel: { url: 'https://duel.com/sports?bt-path=x' }, polyLeg: { price: 0.18 }, duelLeg: { label: 'FORZE Reload', price: 1.26 }, duelStake: 80.9,
};

test('arb message has both legs with amounts, and link buttons', () => {
  const t = arbMessage(row, { bankroll: 100, sportLabel: 'Counter-Strike 2' });
  assert.match(t, /Вилка \+1\.93%/);
  assert.match(t, /Polymarket: <b>G2 Ares<\/b> — купить 101\.9 акций по 0\.180 \(≈\$19\.10\)/);
  assert.match(t, /Duel: <b>FORZE Reload<\/b> @1\.26 — ставка \$80\.90/);
  assert.match(t, /Банк \$100 → \+\$1\.93 · стакан до \$39\.24/);
  assert.match(arbMessage({ ...row, suspicious: true, poly: { ...row.poly, title: 'A <b> & B' } }, { bankroll: 100 }), /⚠️.*A &lt;b&gt; &amp; B/s);
  assert.deepEqual(linkButtons('p', 'd').inline_keyboard[0].map(b => b.url), ['p', 'd']);
});

test('value message', () => {
  const v = { evPct: 8.04, label: 'Победа в матче', poly: row.poly, duelLeg: { label: 'Alliance', price: 2.54 }, stake: 12.91, p: 0.425, fairOdds: 2.35, risk: 'Теннис: риск' };
  const t = valueMessage(v, { valueBank: 1000, kellyFraction: 0.25 });
  assert.match(t, /Валуйка \+8\.0% EV/);
  assert.match(t, /Alliance<\/b> @2\.54 — ставка \$12\.91 \(25% Келли от \$1000\)/);
  assert.match(t, /Теннис: риск/);
});

test('send: JSON request with buttons; API errors surface; blocked request falls back to a form post', async () => {
  const calls = [];
  const ok = async (url, init) => { calls.push([url, init]); return { ok: true, json: async () => ({ ok: true }) }; };
  assert.equal(await sendTelegram('T', '42', 'hi', linkButtons('p', 'd'), ok), true);
  assert.equal(calls[0][0], 'https://api.telegram.org/botT/sendMessage');
  const body = JSON.parse(calls[0][1].body);
  assert.equal(body.chat_id, '42'); assert.equal(body.parse_mode, 'HTML'); assert.equal(body.reply_markup.inline_keyboard[0][1].url, 'd');

  const bad = async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) });
  await assert.rejects(sendTelegram('T', '42', 'hi', null, bad), /Unauthorized/);

  const seen = [];
  const cors = async (url, init) => { seen.push(init); if (!init.mode) throw new TypeError('Failed to fetch'); return {}; };
  assert.equal(await sendTelegram('T', '42', 'hi', linkButtons('p', 'd'), cors), null);
  assert.equal(seen[1].mode, 'no-cors');
  assert.equal(seen[1].body.get('chat_id'), '42');
  assert.match(seen[1].body.get('reply_markup'), /inline_keyboard/);
});

test('chat id from the last message to the bot', async () => {
  const f = async () => ({ json: async () => ({ ok: true, result: [{ message: { chat: { id: 1 } } }, { message: { chat: { id: 777 } } }] }) });
  assert.equal(await findChatId('T', f), 777);
  const empty = async () => ({ json: async () => ({ ok: true, result: [] }) });
  assert.equal(await findChatId('T', empty), null);
});
