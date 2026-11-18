import { DuelApi, polyEvents, polyBooks } from './api.js';
import { parsePolyEvent, parseDuelEvent, duelEventStub } from './markets.js';
import { matchGames, comparePair, valueBets, toPolyFrame } from './compare.js';
import { PolyStream } from './live.js';
import { calcArb } from './calc.js';

// Polymarket series id  <->  Duel sport (found by title in /v4/sports)
const SPORTS = [
  { id: 'cs2', label: 'Counter-Strike 2', series: 10310, duel: /^counter-strike/i },
  { id: 'dota2', label: 'Dota 2', series: 10309, duel: /^dota 2/i },
  { id: 'lol', label: 'League of Legends', series: 10311, duel: /^league of legends$/i },
  { id: 'val', label: 'Valorant', series: 10369, duel: /^valorant/i },
  { id: 'ow', label: 'Overwatch', series: 10430, duel: /^overwatch/i },
  { id: 'cod', label: 'Call of Duty', series: 10427, duel: /^call of duty/i },
  { id: 'r6', label: 'Rainbow Six', series: 10432, duel: /rainbow six/i },
  { id: 'rl', label: 'Rocket League', series: 10433, duel: /^rocket league/i },
  { id: 'hok', label: 'Honor of Kings', series: 10434, duel: /^honor of kings/i },
  { id: 'mlbb', label: 'Mobile Legends', series: 10426, duel: /^mobile legends/i },
  { id: 'wr', label: 'LoL: Wild Rift', series: 10429, duel: /wild rift/i },
  { id: 'sc2', label: 'StarCraft II', series: 10435, duel: /^starcraft/i },
];
const DEFAULTS = {
  duelKey: '', sports: SPORTS.map(s => s.id), bankroll: 100, minProfit: 0, maxProfit: 8, maxAgeMin: 10,
  extraPolyPct: 0, horizonH: 24, maxDuelEvents: 15,
  duelSec: 120, duelHotSec: 30, hotSum: 1.02, discoveryMin: 10,
  minEV: 3, maxSpread: 0.04, minDepthUsd: 20, kellyFraction: 0.25, valueBank: 1000,
};
const FIELDS = ['duelKey', 'bankroll', 'minProfit', 'maxProfit', 'maxAgeMin', 'extraPolyPct', 'horizonH', 'maxDuelEvents', 'duelSec', 'duelHotSec', 'hotSum', 'discoveryMin', 'minEV', 'maxSpread', 'minDepthUsd', 'kellyFraction', 'valueBank'];
const LS = 'duelpoly.settings.v2';
const CREDITS_PER_EVENT = 8; // between bulk (5) and single (10), for estimates

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let S = { ...DEFAULTS, ...load() };
const state = {
  tracked: new Map(), // poly id -> { sp, dSport, poly, duel, perm, score, dtMin, duelAt, rows, best }
  doubt: [], alone: [], restBooks: new Map(), eventOrder: new Map(),
  live: false, busy: false, discoverAt: 0, tick: null,
  spent: 0, liveSince: 0, liveBase: 0, creditsLeft: null, calcId: null, calcEdited: false, seen: new Map(),
};
let api = null;
const stream = new PolyStream({
  onChange: tokens => { for (const t of state.tracked.values()) if (t.tokens?.some(x => tokens.has(x))) recompute(t); render(); },
  onStatus: s => { $('#wsState').textContent = s === 'on' ? 'Polymarket: онлайн' : 'Polymarket: переподключение…'; $('#wsState').className = 'pill ' + (s === 'on' ? 'ok' : 'warn'); },
});

function load() { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } }
function save() { try { localStorage.setItem(LS, JSON.stringify(S)); } catch {} }

// The old PolyArb page installed a service worker: remove it so this page is always fresh.
if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister())).catch(() => {});
if (window.caches) caches.keys().then(ks => ks.forEach(k => caches.delete(k))).catch(() => {});

/* ---------------------------------- form ---------------------------------- */
function fillForm() {
  for (const f of FIELDS) $('#' + f).value = S[f];
  $('#sports').innerHTML = SPORTS.map(sp => `<label><input type="checkbox" value="${sp.id}" ${S.sports.includes(sp.id) ? 'checked' : ''}> ${sp.label}</label>`).join('');
  costNote();
}
function readForm() {
  for (const f of FIELDS) {
    const el = $('#' + f);
    S[f] = el.type === 'number' ? (el.value === '' ? DEFAULTS[f] : +el.value) : el.value.trim();
  }
  S.sports = $$('#sports input:checked').map(i => i.value);
  save(); costNote();
}
/** Credits per hour while real-time mode runs, from the current number of pairs. */
function costPerHour() {
  const pairs = [...state.tracked.values()].filter(t => t.duel);
  const hot = pairs.filter(isHot).length, cold = pairs.length - hot;
  const n = pairs.length || S.maxDuelEvents;
  const odds = pairs.length ? (hot * 3600 / S.duelHotSec + cold * 3600 / S.duelSec) : n * 3600 / S.duelSec;
  const lists = S.sports.length * 5 * 60 / S.discoveryMin;
  return Math.round(odds * CREDITS_PER_EVENT + lists);
}
function costNote() {
  const h = costPerHour();
  const plan = m => (m <= 200 ? 'Free' : m <= 250e3 ? 'Starter $9' : m <= 1.5e6 ? 'Pro $29' : m <= 6e6 ? 'Scale $79' : 'больше Scale');
  $('#costNote').innerHTML = `Реал-тайм ≈ <b>${fmtK(h)}</b> кр./час. 4 ч в день — ${fmtK(h * 120)}/мес (${plan(h * 120)}), 24/7 — ${fmtK(h * 720)}/мес (${plan(h * 720)}). Polymarket бесплатно.`;
}
const fmtK = x => (x >= 1e6 ? (x / 1e6).toFixed(1) + ' млн' : x >= 1e3 ? Math.round(x / 1e3) + ' тыс' : String(Math.round(x)));

/* ----------------------------------- log ---------------------------------- */
function log(msg, cls = '') {
  const el = $('#log');
  const line = document.createElement('div');
  line.className = cls;
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  el.prepend(line);
  while (el.childNodes.length > 400) el.lastChild.remove();
}
function setStatus(t, cls = '') { const el = $('#status'); el.textContent = t; el.className = 'status ' + cls; }

/* ------------------------------- discovery -------------------------------- */
/** Find games on both sites. Costs 5 credits per discipline (+2 for the sports list twice a day). */
async function discover() {
  const active = SPORTS.filter(sp => S.sports.includes(sp.id));
  const duelSports = await api.sports();
  const horizon = Date.now() + S.horizonH * 3600e3;
  const found = new Map(), doubt = [], alone = [];
  for (const sp of active) {
    const dSport = duelSports.find(x => sp.duel.test(x.title || ''));
    let poly;
    try {
      poly = (await polyEvents(sp.series)).map(e => parsePolyEvent(e, sp.id)).filter(g => !g.skip && g.markets.size && g.start <= horizon);
    } catch (e) { log(`Polymarket ${sp.label}: ${e.message}`, 'error'); continue; }
    if (!poly.length) continue;
    if (!dSport || !dSport.events) { alone.push(...poly); continue; }
    const evs = await api.events(dSport.key);
    state.eventOrder.set(dSport.key, evs.map(e => String(e.id)));
    const stubs = evs.map(e => duelEventStub(e)).filter(e => e && e.start <= horizon + 3 * 3600e3);
    const { pairs, doubt: d, unmatched } = matchGames(poly, stubs);
    doubt.push(...d); alone.push(...unmatched);
    for (const p of pairs) found.set(p.poly.id, { ...p, sp, dSport: dSport.key });
    log(`${sp.label}: Polymarket ${poly.length}, Duel ${stubs.length}, пар ${pairs.length}${d.length ? `, под вопросом ${d.length}` : ''}`);
  }
  // keep the nearest pairs within the limit; carry Duel odds over for pairs we already track
  const chosen = [...found.values()].sort((a, b) => a.poly.start - b.poly.start);
  const keep = chosen.slice(0, Math.max(1, S.maxDuelEvents | 0));
  if (chosen.length > keep.length) log(`Пар ${chosen.length}, слежу за ближайшими ${keep.length} (настройка «Не больше матчей Duel»)`, 'warn');
  const next = new Map();
  for (const p of keep) {
    const old = state.tracked.get(p.poly.id);
    next.set(p.poly.id, { ...p, duelTitle: p.duel.title, duel: old && old.duelStubId === p.duel.id ? old.duel : null, duelAt: old?.duelStubId === p.duel.id ? old.duelAt : 0, duelStubId: p.duel.id, rows: old?.rows || [] });
  }
  for (const p of chosen.slice(keep.length)) next.set(p.poly.id, { ...p, duelTitle: p.duel.title, duelStubId: p.duel.id, duel: null, rows: [], skipped: true });
  state.tracked = next; state.doubt = doubt; state.alone = alone; state.discoverAt = Date.now();
}

/* ------------------------------- Duel odds -------------------------------- */
// refreshed more often: close to an arb, or a Duel price above Polymarket's fair line
const isHot = t => (t.best != null && t.best < S.hotSum) || (t.values || []).some(v => v.value || (v.ev > 0 && !v.problems.length));
function due(t, now) {
  if (t.skipped) return false;
  if (!t.duelAt) return true;
  return now - t.duelAt >= (isHot(t) ? S.duelHotSec : S.duelSec) * 1000;
}
/** Fetch Duel odds for pairs that are due (all of them when `all`). */
async function refreshDuel(all = false) {
  const now = Date.now();
  const list = [...state.tracked.values()].filter(t => all ? !t.skipped : due(t, now));
  const bySport = new Map();
  for (const t of list) bySport.set(t.dSport, [...(bySport.get(t.dSport) || []), t]);
  for (const [sport, ts] of bySport) {
    const full = await api.oddsFor(sport, ts.map(t => t.duelStubId), state.eventOrder.get(sport) || []);
    const byId = new Map(full.filter(Boolean).map(e => [String(e.id), e]));
    for (const t of ts) {
      const raw = byId.get(t.duelStubId);
      const d = raw && parseDuelEvent(raw);
      t.duelAt = Date.now(); state.duelTickAt = t.duelAt;
      if (!d || d.skip) { t.duel = null; t.duelSkip = d?.skip || 'нет коэффициентов'; continue; }
      t.duel = d; t.duelSkip = null;
    }
    state.spent = api.spent;
  }
  if (list.length) watchTokens();
  return list.length;
}

/** Subscribe to the Polymarket tokens of every market both sites have. */
function watchTokens() {
  const tokens = [];
  for (const t of state.tracked.values()) {
    if (!t.duel) { t.tokens = []; continue; }
    const duelKeys = new Set([...t.duel.markets.values()].map(m => toPolyFrame(m, t.perm).key));
    t.tokens = [...t.poly.markets.values()].filter(m => duelKeys.has(m.key)).flatMap(m => m.outs.map(o => o.token));
    tokens.push(...t.tokens);
  }
  if (state.live) stream.watch(tokens);
  return tokens;
}

function booksFor(t) {
  const live = stream.books;
  const m = new Map();
  for (const tok of t.tokens || []) {
    const b = live.get(tok);
    if (b) m.set(tok, { asks: b.askLevels(), bids: b.bidLevels() });
    else if (state.restBooks.has(tok)) m.set(tok, state.restBooks.get(tok));
  }
  return m;
}
function recompute(t) {
  if (!t.duel) { t.rows = []; t.values = []; t.best = null; return; }
  if (t.poly.start <= Date.now()) { t.rows = []; t.values = []; t.best = null; t.started = true; return; }
  const pair = { poly: t.poly, duel: t.duel, perm: t.perm, score: t.score }, books = booksFor(t);
  t.rows = comparePair(pair, books, S);
  t.values = valueBets(pair, books, S);
  const clean = t.rows.filter(r => !r.problems.length);
  t.best = clean.length ? Math.min(...clean.map(r => r.sum)) : null;
}

/* ---------------------------------- scan ---------------------------------- */
function needKey() {
  readForm();
  if (S.duelKey) { api = api && api.key === S.duelKey ? api : new DuelApi(S.duelKey, { log }); return true; }
  setStatus('Нужен ключ DuelAPI', 'error'); log('Вставьте ключ DuelAPI слева', 'warn'); return false;
}

/** One full pass: find games, load Duel odds, load order books. */
async function fullScan() {
  if (state.busy || !needKey()) return;
  state.busy = true; $('#scanBtn').disabled = true; setStatus('Сканирую…', 'busy');
  try {
    await discover();
    await refreshDuel(true);
    const tokens = watchTokens();
    try { state.restBooks = await polyBooks(tokens); } catch (e) { log('Стаканы Polymarket: ' + e.message, 'warn'); state.restBooks = new Map(); }
    state.spent = api.spent;
    state.tracked.forEach(recompute);
    const arbs = allRows().filter(isArb).length;
    log(`Готово: пар ${state.tracked.size}, вилок ${arbs}. Потрачено за сессию ~${state.spent} кр.`, arbs ? 'ok' : '');
    setStatus(`${state.live ? 'Реал-тайм' : 'Обновлено'} ${new Date().toLocaleTimeString()} · вилок ${arbs}`, 'ok');
    updateCredits();
  } catch (e) {
    log(e.message, 'error'); setStatus('Ошибка — см. «Лог»', 'error');
    if (e.status === 402 || e.status === 401 || e.status === 403) stopLive();
  } finally {
    state.busy = false; $('#scanBtn').disabled = false; render();
  }
}

async function updateCredits() {
  try { const a = await api.account(); state.creditsLeft = a.credits?.remaining ?? null; } catch {}
  renderCredits();
}

/* -------------------------------- real time -------------------------------- */
async function liveTick() {
  if (!state.live || state.busy) return;
  try {
    if (Date.now() - state.discoverAt > S.discoveryMin * 60e3) { await fullScan(); return; }
    state.busy = true;
    const n = await refreshDuel(false);
    if (n) {
      state.tracked.forEach(recompute);
      setStatus(`Реал-тайм · Duel обновлён ${new Date().toLocaleTimeString()} · вилок ${allRows().filter(isArb).length}`, 'ok');
      render();
    }
  } catch (e) {
    log(e.message, 'error');
    if (e.status === 402 || e.status === 401 || e.status === 403) stopLive();
  } finally { state.busy = false; renderCredits(); }
}
async function startLive() {
  if (!needKey()) return;
  state.live = true; state.liveSince = Date.now(); state.liveBase = api.spent;
  $('#liveBtn').textContent = 'Реал-тайм: вкл'; $('#liveBtn').classList.add('on');
  $('#wsState').hidden = false;
  await fullScan();
  watchTokens();
  clearInterval(state.tick); state.tick = setInterval(liveTick, 5000);
  state.creditTimer = setInterval(updateCredits, 5 * 60e3);
  log('Реал-тайм включён: Polymarket — по WebSocket, Duel — по расписанию', 'ok');
}
function stopLive() {
  state.live = false; clearInterval(state.tick); clearInterval(state.creditTimer); stream.stop();
  $('#liveBtn').textContent = 'Реал-тайм: выкл'; $('#liveBtn').classList.remove('on'); $('#wsState').hidden = true;
  log('Реал-тайм выключен');
}

/* --------------------------------- render --------------------------------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = x => '$' + (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2));
const when = d => d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const ago = ms => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? `${s} с` : `${Math.round(s / 60)} мин`; };
const allRows = () => [...state.tracked.values()].flatMap(t => t.rows.map(r => ({ ...r, t })));
const isArb = r => r.arb && r.profitPct >= S.minProfit;
const gameCell = r => `<div>${esc(r.poly.title)}</div><div class="sub">${when(r.poly.start)} · ${esc(r.poly.tournament || r.duel.tournament)}</div>`;
const openBtns = r => `<div class="go"><a class="btn-pm" href="${esc(r.poly.url)}" target="polymarket" rel="noopener">Polymarket ↗</a><a class="btn-duel" href="${esc(r.duel.url)}" target="duel" rel="noopener">Duel ↗</a></div>`;
const copy = (val, text) => `<span class="copy" data-copy="${val}" title="Скопировать">${text}</span>`;

function renderCredits() {
  const hours = state.live ? (Date.now() - state.liveSince) / 3600e3 : 0;
  const rate = hours > 0.05 ? (api.spent - state.liveBase) / hours : null;
  $('#credits').innerHTML = [
    state.creditsLeft != null ? `кредитов: <b>${state.creditsLeft.toLocaleString('ru-RU')}</b>` : '',
    state.spent ? `за сессию: ${state.spent}` : '',
    rate != null ? `темп: ${fmtK(rate)}/ч` : '',
  ].filter(Boolean).join(' · ');
  costNote();
}

function render() {
  const rows = allRows();
  const arbs = rows.filter(isArb).sort((a, b) => b.profitPct - a.profitPct);
  const now = Date.now();
  for (const r of arbs) if (!state.seen.has(r.id)) state.seen.set(r.id, now);
  const values = [...state.tracked.values()].flatMap(t => (t.values || []).map(v => ({ ...v, t }))).filter(v => v.value).sort((a, b) => b.ev - a.ev);
  for (const v of values) if (!state.seen.has(v.id)) state.seen.set(v.id, now);
  $('#nArbs').textContent = arbs.length;
  $('#nValues').textContent = values.length;
  if (state.live && !state.busy) setStatus(`Реал-тайм · вилок ${arbs.length} · валуек ${values.length}${state.duelTickAt ? ` · Duel ${new Date(state.duelTickAt).toLocaleTimeString()}` : ''}`, 'ok');
  $('#nAll').textContent = rows.length;
  $('#nGames').textContent = state.tracked.size;

  $('#arbBody').innerHTML = arbs.length ? arbs.map(r => `<tr class="${now - state.seen.get(r.id) < 15000 ? 'fresh' : ''}">
      <td><div class="profit ${r.suspicious ? 'sus' : ''}">+${r.profitPct.toFixed(2)}%</div><div class="sub">+${usd(r.profitUsd)} с ${usd(S.bankroll)}</div>${r.suspicious ? '<span class="tag warn">проверь руками</span>' : ''}</td>
      <td>${gameCell(r)}${openBtns(r)}</td>
      <td>${esc(r.label)}</td>
      <td><span class="tag poly">Polymarket</span><span class="side-name">${esc(r.pSide)}</span><br>
          цена <b>${r.polyLeg.price.toFixed(3)}</b> <span class="sub">(с комиссией ${r.qPoly.toFixed(4)})</span><br>
          купить ${copy(r.polyShares.toFixed(2), `<b>${r.polyShares.toFixed(1)}</b> акций`)} ≈ ${copy(r.polyUsd.toFixed(2), `<b>${usd(r.polyUsd)}</b>`)}${r.belowMin ? ` <span class="tag warn">мин. ${r.belowMin} акций</span>` : ''}
          <div class="sub">${state.live && stream.books.has(r.polyLeg.token) ? 'стакан онлайн' : 'стакан на момент скана'}</div></td>
      <td><span class="tag duel">Duel</span><span class="side-name">${esc(r.duelLeg.label)}</span><br>
          кэф <b>${r.duelLeg.price}</b><br>
          поставить ${copy(r.duelStake.toFixed(2), `<b>${usd(r.duelStake)}</b>`)}
          <div class="sub">кэф получен ${ago(r.t.duelAt)} назад${isHot(r.t) && state.live ? ` · обновляю каждые ${S.duelHotSec} с` : ''}</div></td>
      <td>${r.maxBank != null ? `до <b>${usd(r.maxBank)}</b><div class="sub">${r.maxShares.toFixed(0)} акций в стакане</div>${r.bankTooBig ? '<span class="tag warn">банк больше стакана</span>' : ''}` : '—'}
          <div><button class="small calc-open" data-id="${esc(r.id)}">Калькулятор</button></div></td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty">${rows.length ? 'Вилок нет. Ближайшие к вилке — во вкладке «Все сравнения».' : 'Нажмите «Сканировать» или включите реал-тайм.'}</td></tr>`;

  $('#valueBody').innerHTML = values.length ? values.map(v => {
    const d = v.duelLeg, f = v.fair, top = f.quote[v.i];
    const mv = d.move ? `<span class="${d.move < 0 ? 'neg' : 'pos'}">${d.move > 0 ? '▲' : '▼'} с ${d.open}</span>` : '<span class="sub">не двигалась</span>';
    return `<tr class="${now - state.seen.get(v.id) < 15000 ? 'fresh' : ''}">
      <td><div class="profit">+${v.evPct.toFixed(1)}%</div><div class="sub">EV на дистанции</div></td>
      <td>${gameCell(v)}${openBtns(v)}</td>
      <td>${esc(v.label)}</td>
      <td><span class="tag duel">Duel</span><span class="side-name">${esc(d.label)}</span><br>кэф <b>${d.price}</b> · линия ${mv}
          <div class="sub">кэф получен ${ago(v.t.duelAt)} назад</div></td>
      <td>${(v.p * 100).toFixed(1)}% → кэф <b>${v.fairOdds.toFixed(2)}</b>
          <div class="sub">Polymarket ${esc(v.side)}: ${top.bid.toFixed(3)} / ${top.ask.toFixed(3)}, спред ${f.spread.toFixed(3)}</div></td>
      <td>${copy(v.stake.toFixed(2), `<b>${usd(v.stake)}</b>`)}<div class="sub">${(S.kellyFraction * 100).toFixed(0)}% Келли от ${usd(S.valueBank)}</div></td>
    </tr>`;
  }).join('') : `<tr><td colspan="6" class="empty">${rows.length ? `Валуек от ${S.minEV}% нет.` : 'Нажмите «Сканировать» или включите реал-тайм.'}</td></tr>`;

  const all = [...rows].sort((a, b) => a.sum - b.sum);
  $('#allBody').innerHTML = all.length ? all.map(r => `<tr class="${r.problems.length ? 'off' : ''}">
      <td class="${r.arb ? 'sum-good' : ''}">${r.sum.toFixed(4)}</td>
      <td>${gameCell(r)}</td>
      <td>${esc(r.label)}</td>
      <td>${esc(r.pSide)} <b>${r.polyLeg.price.toFixed(3)}</b></td>
      <td>${esc(r.duelLeg.label)} <b>@${r.duelLeg.price}</b></td>
      <td class="sub">${esc(r.problems.join('; ') || (r.arb ? `вилка +${r.profitPct.toFixed(2)}%` : `маржа ${(r.sum * 100 - 100).toFixed(1)}%`))}</td>
      <td>${openBtns(r)}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty">Пока пусто.</td></tr>';

  const tracked = [...state.tracked.values()].sort((a, b) => a.poly.start - b.poly.start);
  $('#pairBody').innerHTML = tracked.length ? tracked.map(t => `<tr>
      <td>${when(t.poly.start)}</td><td><a href="${esc(t.poly.url)}" target="polymarket" rel="noopener">${esc(t.poly.title)}</a></td>
      <td>${t.duel ? `<a href="${esc(t.duel.url)}" target="duel" rel="noopener">${esc(t.duel.title)}</a>` : esc(t.duelTitle)}${t.perm[0] === 1 ? ' <span class="sub">(команды в обратном порядке)</span>' : ''}</td>
      <td>${t.skipped ? '<span class="sub">вне лимита</span>' : t.duel ? `${new Set(t.rows.map(r => r.market.key)).size} · лучшая сумма ${t.best != null ? t.best.toFixed(3) : '—'}${isHot(t) ? ' <span class="tag good">близко</span>' : ''}` : `<span class="sub">${esc(t.duelSkip || 'ещё не загружено')}</span>`}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">—</td></tr>';
  $('#doubtBody').innerHTML = state.doubt.length ? state.doubt.map(d => `<tr>
      <td>${when(d.poly.start)}</td><td>${esc(d.poly.title)}</td><td>${esc(d.duel.title)} <span class="sub">${when(d.duel.start)}</span></td><td class="sub">${esc(d.why)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">—</td></tr>';
  $('#aloneBody').innerHTML = state.alone.length ? [...state.alone].sort((a, b) => a.start - b.start).map(g => `<tr>
      <td>${when(g.start)}</td><td><a href="${esc(g.url)}" target="polymarket" rel="noopener">${esc(g.title)}</a></td></tr>`).join('') : '<tr><td colspan="2" class="empty">—</td></tr>';
  renderCalc();
  renderCredits();
}

/* ------------------------------- calculator ------------------------------- */
function findRow(id) { return allRows().find(r => r.id === id); }
function openCalc(id) {
  const r = findRow(id); if (!r) return;
  state.calcId = id; state.calcEdited = false;
  $('#calc').hidden = false;
  $('#cMode').value = 'bank'; $('#cAmount').value = S.bankroll; $('#cRound').value = '0';
  $('#cPrice').value = r.polyLeg.price; $('#cOdds').value = r.duelLeg.price;
  renderCalc();
}
function renderCalc() {
  if (!state.calcId || $('#calc').hidden) return;
  const r = findRow(state.calcId);
  if (r && !state.calcEdited) { $('#cPrice').value = r.polyLeg.price; $('#cOdds').value = r.duelLeg.price; }
  const base = r || state.calcLast;
  if (!base) return;
  state.calcLast = base;
  $('#cTitle').textContent = `${base.poly.title} — ${base.label}`;
  $('#cSides').innerHTML = `<span class="tag poly">Polymarket</span>${esc(base.pSide)} &nbsp; <span class="tag duel">Duel</span>${esc(base.duelLeg.label)}${!r ? ' <span class="tag warn">матч пропал из сканера</span>' : !r.arb ? ' <span class="tag warn">сейчас не вилка</span>' : ''}`;
  $('#cGo').innerHTML = openBtns(base);
  const res = calcArb({
    price: +$('#cPrice').value, fee: base.polyLeg.fee, extraPct: S.extraPolyPct, odds: +$('#cOdds').value,
    mode: $('#cMode').value, amount: +$('#cAmount').value, roundDuel: +$('#cRound').value,
  });
  $('#cOut').innerHTML = res ? `
    <div class="calc-grid">
      <div>Polymarket: купить</div><div>${copy(res.shares.toFixed(2), `<b>${res.shares.toFixed(2)}</b> акций`)} за ${copy(res.polyUsd.toFixed(2), `<b>${usd(res.polyUsd)}</b>`)} <span class="sub">(комиссия ${usd(res.feeUsd)})</span></div>
      <div>Duel: поставить</div><div>${copy(res.duelStake.toFixed(2), `<b>${usd(res.duelStake)}</b>`)} по ${(+$('#cOdds').value).toFixed(2)}</div>
      <div>Всего</div><div><b>${usd(res.total)}</b> · сумма вероятностей ${res.sum.toFixed(4)}</div>
      <div>Если выиграет Polymarket</div><div class="${res.winPoly >= 0 ? 'pos' : 'neg'}">${res.winPoly >= 0 ? '+' : ''}${usd(res.winPoly)}</div>
      <div>Если выиграет Duel</div><div class="${res.winDuel >= 0 ? 'pos' : 'neg'}">${res.winDuel >= 0 ? '+' : ''}${usd(res.winDuel)}</div>
      <div>Гарантированно</div><div class="${res.worst >= 0 ? 'pos' : 'neg'}"><b>${res.worst >= 0 ? '+' : ''}${usd(res.worst)} (${res.worstPct.toFixed(2)}%)</b></div>
    </div>` : '<p class="sub">Проверьте цену (0–1) и кэф (> 1).</p>';
}

/* ---------------------------------- wire ---------------------------------- */
$$('.tab').forEach(b => b.addEventListener('click', () => {
  $$('.tab').forEach(x => x.classList.toggle('active', x === b));
  $$('.panel').forEach(p => p.classList.toggle('hidden', p.id !== 'tab-' + b.dataset.tab));
}));
document.addEventListener('change', e => { if (e.target.closest('.side')) { readForm(); state.tracked.forEach(recompute); render(); } });
document.addEventListener('click', e => {
  const c = e.target.closest('[data-copy]');
  if (c) { navigator.clipboard?.writeText(c.dataset.copy); c.classList.add('copied'); setTimeout(() => c.classList.remove('copied'), 800); }
  const o = e.target.closest('.calc-open');
  if (o) openCalc(o.dataset.id);
});
$('#scanBtn').addEventListener('click', fullScan);
$('#liveBtn').addEventListener('click', () => (state.live ? stopLive() : startLive()));
$('#calcClose').addEventListener('click', () => { $('#calc').hidden = true; state.calcId = null; });
['#cPrice', '#cOdds'].forEach(s => $(s).addEventListener('input', () => { state.calcEdited = true; renderCalc(); }));
['#cMode', '#cAmount', '#cRound'].forEach(s => $(s).addEventListener('input', renderCalc));
$('#cReset').addEventListener('click', () => { state.calcEdited = false; renderCalc(); });
setInterval(() => { if (state.tracked.size) render(); }, 15000); // keep "N s ago" fresh
fillForm();
render();
