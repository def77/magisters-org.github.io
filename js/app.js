import { DEFAULT_SPORTS, DEFAULT_SETTINGS, EXCHANGE_KEYS } from './config.js';
import { fetchPolymarket, fetchGammaEvents, fetchOdds, fetchBooks, parsePolyEvent, parseOddsEvent, sendTelegram } from './sources.js';
import { scan, applyDepth } from './scanner.js';
import { polyCost, polyFeeRate } from './arb.js';
import { OddsPapi } from './oddspapi.js';
import { parseGammaEsports, matchFixture, oddsPapiLines, esportsArbs, lineEntries, periodLabel, outcomeLabel } from './esports.js';
import { valueBets, findMiddles } from './value.js';
import { loadJournal, saveJournal, entryPnl, expectedPnl, journalStats, toCSV } from './journal.js';
import { demoData, demoBooks, demoEsports } from './demo.js';

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const LS = 'polyarb.settings.v1';
const SEEN = 'polyarb.alerted.v1';
const HIDDEN = 'polyarb.hidden.v1';
const FIRST = 'polyarb.firstseen.v1';

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let S = { ...DEFAULT_SETTINGS, ...store.get(LS, {}) };
let state = { overview: [], unmatched: [], arbs: [], values: [], middles: [], lastScan: null, busy: false, timer: null, credits: null, papiUsed: 0, demo: false };
const alerted = new Set(store.get(SEEN, []));
const hidden = new Set(store.get(HIDDEN, []));
const firstSeen = store.get(FIRST, {});
let calc = null; // { arb, bank, prices[], stakes[] }

function sports() {
  if (S.sportsOverride.trim()) {
    try { const v = JSON.parse(S.sportsOverride); if (Array.isArray(v)) return v; } catch {}
  }
  return DEFAULT_SPORTS;
}
const sportById = id => sports().find(s => s.id === id);
const sportLabel = id => sportById(id)?.label || id;

/* ---------------- logging ---------------- */
function log(msg, level = 'info') {
  const el = document.createElement('div');
  el.className = 'log-' + level;
  el.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  const box = $('#log');
  box.prepend(el);
  while (box.children.length > 300) box.lastChild.remove();
}

/* ---------------- settings form ---------------- */
const FIELDS = ['sharpBook', 'minEV', 'kellyFraction', 'valuePolyOnly', 'maxMiddleLoss', 'oddsApiKey', 'regions', 'bookmakers', 'oddspapiKey', 'oddspapiBooks', 'oddspapiMaxFixtures', 'scanHours',
  'minProfit', 'maxProfit', 'minOdds', 'maxOdds', 'maxQuoteAgeMin', 'minLiquidity', 'polyFee', 'exchangeCommission', 'bankroll', 'roundTo', 'rubRate',
  'timeTolerance', 'matchThreshold', 'refreshSec', 'includeBookOnly', 'useOrderBook', 'corsProxy',
  'tgToken', 'tgChat', 'browserNotify', 'sportsOverride', 'search'];

function renderSportChips() {
  for (const [kind, box] of [['esports', $('#sportsEsports')], ['classic', $('#sportsClassic')]]) {
    box.innerHTML = '';
    for (const sp of sports().filter(x => (x.kind || 'classic') === kind)) {
      const lab = document.createElement('label');
      lab.className = 'chip';
      lab.innerHTML = `<input type="checkbox" ${S.sports.includes(sp.id) ? 'checked' : ''}><span>${esc(sp.label)}</span>`;
      lab.querySelector('input').addEventListener('change', e => {
        S.sports = e.target.checked ? [...new Set([...S.sports, sp.id])] : S.sports.filter(x => x !== sp.id);
        save();
      });
      box.append(lab);
    }
  }
}

function fillForm() {
  for (const f of FIELDS) {
    const el = document.getElementById(f);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!S[f]; else el.value = S[f] ?? '';
  }
  renderSportChips();
  applyTheme();
  setSortButtons();
}

function readForm() {
  for (const f of FIELDS) {
    const el = document.getElementById(f);
    if (!el) continue;
    if (el.type === 'checkbox') S[f] = el.checked;
    else if (el.type === 'number') S[f] = el.value === '' ? DEFAULT_SETTINGS[f] : +el.value;
    else S[f] = el.value.trim();
  }
}
function save() { store.set(LS, S); }

function applyTheme() {
  document.documentElement.dataset.theme = S.theme === 'light' ? 'light' : 'dark';
  $('#themeBtn').textContent = S.theme === 'light' ? '☾' : '☀';
}
function setSortButtons() {
  $$('[data-sort]').forEach(b => b.classList.toggle('active', b.dataset.sort === S.sortBy));
}

/* ---------------- scanning ---------------- */
async function runScan({ demo = false } = {}) {
  if (state.busy) return;
  readForm(); save();
  const active = sports().filter(sp => S.sports.includes(sp.id));
  if (!active.length) return log('Выберите хотя бы один вид спорта', 'warn');
  const needClassicKey = active.some(sp => (sp.kind || 'classic') === 'classic');
  const needPapiKey = active.some(sp => sp.kind === 'esports');
  if (!demo && ((needClassicKey && !S.oddsApiKey) || (needPapiKey && !S.oddspapiKey))) {
    if (!S.oddsApiKey && !S.oddspapiKey) { log('Нет ни одного ключа — запускаю демо-режим.', 'warn'); demo = true; }
    else {
      if (needClassicKey && !S.oddsApiKey) log('Нет ключа The Odds API — классический спорт без букмекеров.', 'warn');
      if (needPapiKey && !S.oddspapiKey) log('Нет ключа OddsPapi — киберспорт без букмекеров.', 'warn');
    }
  }
  state.busy = true;
  setStatus(demo ? 'Демо-скан…' : 'Сканирую…', 'busy');
  $('#scanBtn').disabled = true;

  try {
    const results = await Promise.all([
      scanClassic(active.filter(sp => (sp.kind || 'classic') === 'classic'), demo),
      scanEsports(active.filter(sp => sp.kind === 'esports'), demo),
    ]);
    let arbs = results.flatMap(r => r.arbs);
    const overview = results.flatMap(r => r.overview);
    const values = results.flatMap(r => r.values || []).sort((a, b) => b.evPct - a.evPct);
    const middles = results.flatMap(r => r.middles || []).sort((a, b) => b.singlePct - a.singlePct);
    const unmatched = results.flatMap(r => r.unmatched);

    if (S.useOrderBook && arbs.length) {
      const tokens = arbs.flatMap(a => a.legs.filter(l => l.src === 'poly').map(l => l.token));
      try {
        const books = demo ? demoBooks(tokens, results.flatMap(r => r.polyLegs || [])) : await fetchBooks(tokens, S.corsProxy);
        arbs.forEach(a => applyDepth(a, books, S));
        log(`Стаканы CLOB: ${books.size} токенов`);
      } catch (e) { log('Стаканы CLOB: ' + e.message, 'error'); }
    }
    arbs.forEach(applyBookLimits);
    arbs = arbs.filter(a => a.profitPct >= S.minProfit);

    const now = Date.now();
    for (const a of arbs) { const k = arbKey(a); if (!firstSeen[k]) firstSeen[k] = now; a.firstSeen = firstSeen[k]; }
    for (const k of Object.keys(firstSeen)) if (now - firstSeen[k] > 2 * 86400e3) delete firstSeen[k];
    store.set(FIRST, firstSeen);

    state = { ...state, overview, unmatched, arbs, values, middles, lastScan: new Date(), demo };
    const shown = visibleArbs();
    log(`Готово: сопоставлено ${overview.length}, без пары ${unmatched.length}, вилок ${arbs.length} (показано ${shown.length})`, arbs.length ? 'ok' : 'info');
    render();
    if (!demo) await alertNew(shown);
    setStatus(`Обновлено ${state.lastScan.toLocaleTimeString()}${demo ? ' · ДЕМО' : ''}`, 'ok');
  } catch (e) {
    log(e.message, 'error');
    setStatus('Ошибка — см. лог', 'error');
  } finally {
    state.busy = false;
    $('#scanBtn').disabled = false;
    schedule();
  }
}

const matchOf = m => ({ id: m.poly.id, title: m.poly.title, url: m.poly.url, sport: m.poly.sport, start: m.poly.start || m.odds.start, other: m.odds.title, score: m.score });
const valueOpts = () => ({ sharpKey: S.sharpBook || 'pinnacle', minEV: S.minEV, kellyFraction: S.kellyFraction, bankroll: S.bankroll, polyOnly: S.valuePolyOnly });

async function scanClassic(list, demo) {
  if (!list.length) return { arbs: [], overview: [], unmatched: [] };
  const polyGames = [], oddsBySport = {};
  if (demo) {
    const d = demoData();
    for (const sp of list) {
      polyGames.push(...(d.gamma[sp.id] || []).map(e => parsePolyEvent(e, sp)).filter(Boolean));
      oddsBySport[sp.id] = (d.odds[sp.id] || []).map(parseOddsEvent);
    }
  } else {
    await Promise.all(list.map(async sp => {
      const [p, o] = await Promise.allSettled([
        fetchPolymarket(sp, S.corsProxy, log, S.scanHours),
        S.oddsApiKey ? fetchOdds(sp, S, log) : Promise.resolve({ events: [] }),
      ]);
      if (p.status === 'fulfilled') polyGames.push(...p.value);
      else log(`Polymarket ${sp.label}: ${p.reason.message}`, 'error');
      if (o.status === 'fulfilled') { oddsBySport[sp.id] = o.value.events; if (o.value.remaining) state.credits = o.value.remaining; }
      else log(`Букмекеры ${sp.label}: ${o.reason.message}`, 'error');
    }));
  }
  const res = scan(polyGames, oddsBySport, S);
  const arbs = res.matches.flatMap(m => m.arbs.map(a => ({
    ...a, legs: a.legs.map(l => ({ ...l, team: l.label })),
    match: matchOf(m),
  })));
  const overview = res.matches.map(m => ({
    id: m.poly.id, title: m.poly.title, url: m.poly.url, sport: m.poly.sport, start: m.poly.start || m.odds.start,
    other: m.odds.title, score: m.score, books: m.odds.books.length,
    lines: m.best ? [{ name: m.poly.outcomes.length === 3 ? '1X2' : 'Исход', sum: m.best.sum, legs: m.best.legs }] : [],
  }));
  const polyLegs = polyGames.flatMap(g => g.outcomes.flatMap(o => [o.yes, o.no].filter(Boolean)));
  const values = res.matches.flatMap(m => valueBets(m.poly.outcomes.length, m.quotes.filter(q => q.set.length === 1), valueOpts())
    .map(v => ({ ...v, quote: { ...v.quote, team: v.quote.label }, match: matchOf(m) })));
  return { arbs, values, overview, unmatched: res.unmatched.map(g => ({ title: g.title, url: g.url, sport: g.sport, teams: g.outcomes.map(o => o.name) })), polyLegs };
}

async function scanEsports(list, demo) {
  if (!list.length) return { arbs: [], overview: [], unmatched: [] };
  const arbs = [], overview = [], unmatched = [], polyLegs = [], values = [], middles = [];
  let papi = null, marketsMap = {};
  const d = demo ? demoEsports() : null;
  if (!demo && S.oddspapiKey) {
    papi = new OddsPapi(S.oddspapiKey, { proxy: S.corsProxy, log });
    try { marketsMap = await papi.markets(list.map(sp => sp.papi)); }
    catch (e) { log('OddsPapi рынки: ' + e.message, 'error'); papi = null; }
  } else if (demo) marketsMap = d.markets;

  for (const sp of list) {
    let games = [];
    try {
      const events = demo ? (d.gamma[sp.id] || []) : await fetchGammaEvents(sp, S.corsProxy, S.scanHours);
      games = events.map(e => parseGammaEsports(e, sp)).filter(g => g && g.markets.length);
      games.forEach(g => g.markets.forEach(m => polyLegs.push(...m.legs.map(l => ({ ...l })))));
      log(`Polymarket ${sp.label}: ${games.length} матчей`);
    } catch (e) { log(`Polymarket ${sp.label}: ${e.message}`, 'error'); continue; }
    if (!papi && !demo) { unmatched.push(...games.map(g => ({ title: g.title, url: g.url, sport: sp.id, teams: g.teams }))); continue; }

    let fixtures = [];
    try { fixtures = demo ? (d.fixtures[sp.id] || []) : await papi.fixtures(sp.papi, S.scanHours); }
    catch (e) { log(`OddsPapi ${sp.label}: ${e.message}`, 'error'); continue; }

    const pairs = [];
    const used = new Set();
    for (const g of games) {
      const m = matchFixture(g, fixtures, { threshold: S.matchThreshold, timeTolerance: S.timeTolerance });
      if (!m || used.has(m.fixture.id)) { unmatched.push({ title: g.title, url: g.url, sport: sp.id, teams: g.teams }); continue; }
      used.add(m.fixture.id);
      pairs.push({ game: g, ...m });
    }
    pairs.sort((a, b) => (a.game.start || 0) - (b.game.start || 0));
    const limit = demo ? pairs.length : Math.max(1, S.oddspapiMaxFixtures | 0);
    if (pairs.length > limit) log(`${sp.label}: сопоставлено ${pairs.length}, коэффициенты беру для ближайших ${limit} (настройка «Матчей за скан»)`, 'warn');
    for (const p of pairs.slice(0, limit)) {
      let odds;
      try { odds = demo ? d.odds[p.fixture.id] : await papi.odds(p.fixture.id, S.oddspapiBooks); }
      catch (e) { log(`OddsPapi ${p.fixture.title}: ${e.message}`, 'error'); if (e.status === 401 || e.status === 403 || e.status === 429) break; continue; }
      const lines = oddsPapiLines(odds, marketsMap, p.swap, S);
      const res = esportsArbs(p.game, lines, S);
      const match = { id: p.game.id, title: p.game.title, url: p.game.url, sport: sp.id, start: p.game.start || p.fixture.start, other: [p.game.tournament || p.fixture.tournament, p.fixture.title].filter(Boolean).join(' · '), score: p.score };
      arbs.push(...res.arbs.map(a => ({ ...a, legs: a.legs.map(l => ({ ...l })), match })));
      const entries = lineEntries(p.game, lines, S);
      for (const e of entries) {
        const qs = [...e.quotes[0], ...e.quotes[1]];
        values.push(...valueBets(2, qs, valueOpts()).map(v => ({ ...v, match })));
      }
      middles.push(...findMiddles(entries, { maxLoss: S.maxMiddleLoss, includeBookOnly: S.includeBookOnly }).map(x => ({ ...x, match })));
      overview.push({
        ...match, books: Object.keys(odds?.bookmakerOdds || {}).length,
        lines: res.compared.map(c => ({ name: `${c.best.legs[0].label.replace(/^.*\(/, '(')}`, label: c.best.legs.map(l => l.label.split(' ')[0]).join(' / '), sum: c.best.sum, legs: c.best.legs })),
      });
    }
    if (papi) { state.papiUsed = papi.used; log(`OddsPapi: потрачено запросов за скан — ${papi.used}`); }
  }
  return { arbs, values, middles, overview, unmatched, polyLegs };
}

/** Bookmaker stake limits (OddsPapi) cap the bankroll too. */
function applyBookLimits(a) {
  for (const l of a.legs) {
    if (l.src !== 'book' || !(l.limit > 0)) continue;
    const cap = l.limit * a.sum / l.q;
    a.maxBankroll = a.maxBankroll == null ? cap : Math.min(a.maxBankroll, cap);
  }
}

function schedule() {
  clearTimeout(state.timer);
  if (S.refreshSec >= 15) state.timer = setTimeout(() => runScan({ demo: state.demo }), S.refreshSec * 1000);
}

/* ---------------- filtering ---------------- */
const arbKey = a => a.match.id + '|' + a.legs.map(l => `${l.bookKey}:${l.label}`).join('/');

function visibleArbs() {
  const q = (S.search || '').toLowerCase();
  let list = state.arbs.filter(a => {
    if (hidden.has(a.match.id)) return false;
    if (a.legs.some(l => l.src === 'book' && (l.price < S.minOdds || l.price > S.maxOdds))) return false;
    if (S.minLiquidity && a.maxBankroll != null && a.maxBankroll < S.minLiquidity) return false;
    if (q && !(`${a.match.title} ${a.match.other} ${a.legs.map(l => l.book).join(' ')}`.toLowerCase().includes(q))) return false;
    return true;
  });
  list.sort(S.sortBy === 'time'
    ? (a, b) => (a.match.start || 0) - (b.match.start || 0) || b.profitPct - a.profitPct
    : (a, b) => b.profitPct - a.profitPct);
  return list;
}

/* ---------------- alerts ---------------- */
async function alertNew(arbs) {
  const fresh = arbs.filter(a => !alerted.has(arbKey(a)) && a.profitPct <= S.maxProfit);
  if (!fresh.length) return;
  fresh.forEach(a => alerted.add(arbKey(a)));
  store.set(SEEN, [...alerted].slice(-1000));
  beep();
  for (const a of fresh.slice(0, 10)) {
    const text = `🟢 <b>${a.profitPct.toFixed(2)}%</b> ${esc(a.match.title)} (${esc(sportLabel(a.match.sport))})\n` +
      a.legs.map(l => `• ${esc(l.book)} — ${esc(l.label)}${l.team && l.team !== l.label ? ' ' + esc(l.team) : ''} @ ${fmtPrice(l)}`).join('\n') +
      (a.maxBankroll ? `\nЛимит ≈ $${Math.round(a.maxBankroll)}` : '') + `\n${a.match.url}`;
    if (S.tgToken && S.tgChat) sendTelegram(S.tgToken, S.tgChat, text).catch(e => log('Telegram: ' + e.message, 'error'));
    if (S.browserNotify) notify(`Вилка ${a.profitPct.toFixed(2)}% · ${sportLabel(a.match.sport)}`,
      `${a.match.title}\n${a.legs.map(l => `${l.book}: ${l.label} @ ${fmtPrice(l)}`).join('\n')}`, a.match.url, arbKey(a));
  }
}

/** Device notification. Through the service worker when there is one (needed on Android / installed iOS app). */
async function notify(title, body, url, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  const opts = { body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url } };
  try {
    const reg = 'serviceWorker' in navigator && await navigator.serviceWorker.getRegistration();
    if (reg) { await reg.showNotification(title, opts); return true; }
  } catch {}
  try { new Notification(title, opts); return true; } catch { return false; }
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 880; g.gain.value = 0.05;
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.15);
  } catch {}
}

/* ---------------- formatting ---------------- */
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const fmtPrice = l => l.src === 'poly' ? `${(l.price * 100).toFixed(1)}¢ (${(1 / l.q).toFixed(2)})` : (+l.price).toFixed(2);
const fmtTime = d => d ? new Date(d).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const money = v => (v < 0 ? '−$' : '$') + (Math.abs(v) >= 100 ? Math.round(Math.abs(v)).toLocaleString() : Math.abs(+v).toFixed(2));
const rub = v => S.rubRate > 0 ? ` <span class="sub">≈ ${Math.round(v * S.rubRate).toLocaleString()} ₽</span>` : '';
function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин`;
  return `${Math.floor(s / 3600)} ч ${Math.floor((s % 3600) / 60)} мин`;
}

function freshness(l) {
  if (l.src !== 'book' || !l.updated) return '';
  const t = new Date(l.updated).getTime();
  if (!isFinite(t)) return '';
  const min = (Date.now() - t) / 60e3;
  return ` <span class="age ${min > 30 ? 'old' : ''}" title="Коэффициент у букмекера последний раз менялся ${new Date(t).toLocaleTimeString()}">${min < 1 ? 'сейчас' : ago(t)}</span>`;
}

/* ---------------- rendering ---------------- */
function render() {
  const arbs = visibleArbs();
  $('#statArbs').textContent = arbs.length;
  $('#statBest').textContent = arbs[0] ? arbs[0].profitPct.toFixed(2) + '%' : '—';
  $('#statMatched').textContent = state.overview.length;
  $('#statCredits').textContent = [state.credits != null ? `OA ${state.credits}` : '', state.papiUsed ? `OP −${state.papiUsed}` : ''].filter(Boolean).join(' · ') || '—';
  $('#tabArbsCount').textContent = arbs.length;
  $('#tabMatchCount').textContent = state.overview.length;
  $('#tabUnmatchedCount').textContent = state.unmatched.length;
  $('#tabValueCount').textContent = filtered(state.values, v => [v.quote]).length;
  $('#tabMiddleCount').textContent = filtered(state.middles, x => x.legs).length;
  $('#hiddenCount').textContent = hidden.size;
  renderArbs(arbs); renderOverview(); renderUnmatched(); renderValues(); renderMiddles();
}

function renderArbs(arbs) {
  const tb = $('#arbBody');
  if (!arbs.length) {
    tb.innerHTML = `<tr><td colspan="6" class="empty">${state.lastScan ? 'Вилок по фильтрам нет. Снизьте «Мин. профит» или посмотрите вкладку «Сопоставленные».' : 'Нажмите «Сканировать» или «Демо».'}</td></tr>`;
    return;
  }
  tb.innerHTML = '';
  arbs.forEach(a => {
    const m = a.match;
    const suspicious = a.profitPct > S.maxProfit;
    const tr = document.createElement('tr');
    tr.className = 'arb-row' + (calc?.arb === a ? ' selected' : '');
    tr.innerHTML = `
      <td class="nowrap c-profit"><span class="profit ${a.profitPct >= 2 ? 'hot' : ''} ${suspicious ? 'sus' : ''}" title="${suspicious ? 'Подозрительно высокий профит — проверьте линию и сопоставление' : ''}">${a.profitPct.toFixed(2)}%</span>
        <div class="sub">${a.firstSeen ? ago(a.firstSeen) : ''}</div></td>
      <td class="c-event"><div class="ev">${esc(m.title)}</div><div class="sub">${esc(sportLabel(m.sport))} · ${fmtTime(m.start)}</div>
        <div class="sub dim">${esc(m.other)} · совпадение ${(m.score * 100).toFixed(0)}%</div></td>
      <td class="c-bets" data-label="Ставки">${a.legs.map(l => `<div class="leg"><span class="lbl">${esc(l.label)}</span>${l.team && l.team !== l.label ? ` <span class="sub">${esc(l.team)}</span>` : ''}</div>`).join('')}</td>
      <td class="c-books" data-label="Где">${a.legs.map(l => `<div class="leg"><span class="src ${l.src}">${esc(l.book)}</span> <span class="m-only lbl">${esc(l.label)}${l.team && l.team !== l.label ? ' ' + esc(l.team) : ''}</span> <b>${fmtPrice(l)}</b>${l.limit ? ` <span class="sub">лим ${Math.round(l.limit)}</span>` : ''}${freshness(l)}</div>`).join('')}</td>
      <td class="nowrap c-limit" data-label="Лимит">${a.maxBankroll != null ? money(a.maxBankroll) : '—'}</td>
      <td class="nowrap actions-cell">
        <a class="ghost small btn" href="${m.url}" target="_blank" rel="noopener" title="Открыть на Polymarket">Poly</a>
        ${a.legs.filter(l => l.src === 'book' && l.url).slice(0, 1).map(l => `<a class="ghost small btn" href="${esc(l.url)}" target="_blank" rel="noopener" title="Открыть у букмекера">БК</a>`).join('')}
        <button class="ghost small" data-act="calc" title="В калькулятор">⚖</button>
        <button class="ghost small" data-act="hide" title="Скрыть событие">✕</button>
      </td>`;
    tr.querySelector('[data-act="calc"]').addEventListener('click', () => openCalc(a));
    tr.querySelector('[data-act="hide"]').addEventListener('click', () => { hidden.add(m.id); store.set(HIDDEN, [...hidden]); render(); });
    tb.append(tr);
  });
}

/** Same visibility rules as arbs: hidden events and search. */
function filtered(list, legsOf) {
  const q = (S.search || '').toLowerCase();
  return list.filter(x => !hidden.has(x.match.id) &&
    (!q || `${x.match.title} ${x.match.other} ${legsOf(x).map(l => l.book).join(' ')}`.toLowerCase().includes(q)));
}

function renderValues() {
  const tb = $('#valueBody');
  const list = filtered(state.values, v => [v.quote]);
  if (!list.length) { tb.innerHTML = `<tr><td colspan="6" class="empty">${state.lastScan ? `Валуйных ставок с EV ≥ ${S.minEV}% нет. Для расчёта нужен «острый» бук (${esc(S.sharpBook)}) в линии матча.` : 'Нажмите «Сканировать» или «Демо».'}</td></tr>`; return; }
  tb.innerHTML = list.map(v => {
    const l = v.quote, m = v.match;
    return `<tr>
      <td class="nowrap"><span class="profit ${v.evPct >= 5 ? 'hot' : ''} ${v.evPct > S.maxProfit ? 'sus' : ''}">+${v.evPct.toFixed(2)}%</span></td>
      <td><div class="ev">${esc(m.title)}</div><div class="sub">${esc(sportLabel(m.sport))} · ${fmtTime(m.start)}</div></td>
      <td><div class="leg"><span class="lbl">${esc(l.label)}</span>${l.team && l.team !== l.label ? ` <span class="sub">${esc(l.team)}</span>` : ''}</div>
        <div class="leg"><span class="src ${l.src}">${esc(l.book)}</span> <b>${fmtPrice(l)}</b>${freshness(l)}</div></td>
      <td class="nowrap">${v.fairOdds.toFixed(2)}<div class="sub">${(v.p * 100).toFixed(1)}% · маржа ${esc(S.sharpBook)} ${(v.sharpMargin * 100).toFixed(1)}%</div></td>
      <td class="nowrap"><b>${money(v.stake)}</b><div class="sub">${(v.kelly * S.kellyFraction * 100).toFixed(1)}% банка</div></td>
      <td class="nowrap"><a class="ghost small btn" href="${l.src === 'poly' ? m.url : esc(l.url || m.url)}" target="_blank" rel="noopener">${l.src === 'poly' ? 'Poly' : 'БК'}</a></td></tr>`;
  }).join('');
}

function renderMiddles() {
  const tb = $('#middleBody');
  const list = filtered(state.middles, x => x.legs);
  if (!list.length) { tb.innerHTML = `<tr><td colspan="5" class="empty">${state.lastScan ? `Коридоров с минусом не больше ${S.maxMiddleLoss}% нет.` : 'Нажмите «Сканировать» или «Демо».'}</td></tr>`; return; }
  tb.innerHTML = list.map(x => {
    const m = x.match, bank = S.bankroll;
    const what = `${x.type === 'hcp' ? 'фора' : 'тотал'} · ширина коридора ${x.width}`;
    return `<tr>
      <td class="nowrap"><span class="profit ${x.singlePct >= 0 ? 'hot' : ''}">${x.singlePct >= 0 ? '+' : ''}${x.singlePct.toFixed(2)}%</span>
        <div class="sub">коридор +${x.bothPct.toFixed(0)}%</div></td>
      <td><div class="ev">${esc(m.title)}</div><div class="sub">${esc(sportLabel(m.sport))} · ${fmtTime(m.start)} · ${esc(what)}</div></td>
      <td>${x.legs.map(l => `<div class="leg"><span class="lbl">${esc(l.label)}</span>${l.team ? ` <span class="sub">${esc(l.team)}</span>` : ''}</div>`).join('')}</td>
      <td>${x.legs.map((l, i) => `<div class="leg"><span class="src ${l.src}">${esc(l.book)}</span> <b>${fmtPrice(l)}</b> · ${money(bank * (i ? x.share2 : x.share1))}${freshness(l)}</div>`).join('')}</td>
      <td class="nowrap"><a class="ghost small btn" href="${m.url}" target="_blank" rel="noopener">Poly</a></td></tr>`;
  }).join('');
}

function renderOverview() {
  const tb = $('#matchBody');
  const rows = [...state.overview].map(o => ({ ...o, bestSum: Math.min(9, ...o.lines.map(l => l.sum)) })).sort((a, b) => a.bestSum - b.bestSum);
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="4" class="empty">Нет данных</td></tr>'; return; }
  tb.innerHTML = rows.map(o => `<tr>
      <td><div class="ev"><a class="link" href="${o.url}" target="_blank" rel="noopener">${esc(o.title)}</a></div>
        <div class="sub">${esc(sportLabel(o.sport))} · ${esc(o.other)} · ${(o.score * 100).toFixed(0)}%</div></td>
      <td class="nowrap">${fmtTime(o.start)}</td>
      <td>${o.lines.length ? o.lines.sort((a, b) => a.sum - b.sum).slice(0, 6).map(l => {
        const margin = (l.sum - 1) * 100;
        return `<div class="leg"><span class="${margin < 0 ? 'pos' : 'neg'}">${margin < 0 ? '+' + (-margin).toFixed(2) + '%' : '−' + margin.toFixed(2) + '%'}</span>
          ${l.legs.map(x => `<span class="src ${x.src}">${esc(x.book)}</span> ${esc(x.label)} ${fmtPrice(x)}`).join(' · ')}</div>`;
      }).join('') : '<span class="sub">общих рынков не найдено</span>'}</td>
      <td class="nowrap">${o.books}</td></tr>`).join('');
}

function renderUnmatched() {
  const tb = $('#unmatchedBody');
  if (!state.unmatched.length) { tb.innerHTML = '<tr><td colspan="3" class="empty">Все матчи сопоставлены</td></tr>'; return; }
  tb.innerHTML = state.unmatched.map(g => `<tr><td><a class="link" href="${g.url}" target="_blank" rel="noopener">${esc(g.title)}</a></td>
    <td>${esc(sportLabel(g.sport))}</td><td>${(g.teams || []).map(esc).join(' / ')}</td></tr>`).join('');
}

function setStatus(text, cls) {
  const el = $('#status');
  el.textContent = text; el.className = 'status ' + cls;
}

/* ---------------- calculator ---------------- */
function legQ(l, price) {
  if (l.src === 'poly') return polyCost(price, S.polyFee, l.fee);
  return l.q * l.price / price; // keeps exchange commission proportional
}

function openCalc(a) {
  calc = { arb: a, bank: S.bankroll, prices: a.legs.map(l => l.price), fixed: null };
  $('#calcPanel').classList.remove('hidden');
  $('#calcPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  renderCalc(); render();
}

function calcNumbers() {
  const a = calc.arb;
  const qs = a.legs.map((l, i) => legQ(l, +calc.prices[i] || l.price));
  const sum = qs.reduce((x, y) => x + y, 0);
  let stakes = qs.map(q => calc.bank * q / sum);
  if (calc.fixed) { // user typed one stake: scale the rest to it
    const k = calc.fixed.value / stakes[calc.fixed.i];
    stakes = stakes.map(s => s * k);
  }
  stakes = stakes.map((s, i) => a.legs[i].src === 'book' && S.roundTo > 0 ? Math.round(s / S.roundTo) * S.roundTo : s);
  const total = stakes.reduce((x, y) => x + y, 0);
  const payouts = stakes.map((s, i) => s / qs[i]);
  const profit = Math.min(...payouts) - total;
  return { qs, sum, stakes, total, payouts, profit, pct: total ? profit / total * 100 : 0 };
}

function renderCalc() {
  const box = $('#calcBody');
  if (!calc) { $('#calcPanel').classList.add('hidden'); return; }
  const a = calc.arb, n = calcNumbers();
  $('#calcTitle').textContent = `${a.match.title} · ${sportLabel(a.match.sport)}`;
  box.innerHTML = a.legs.map((l, i) => {
    const feePct = l.src === 'poly' ? polyFeeRate(+calc.prices[i] || l.price, l.fee) * 100 + S.polyFee : 0;
    return `<div class="calc-leg">
      <div class="cl-name"><b>${esc(l.label)}</b> <span class="sub">${esc(l.team && l.team !== l.label ? l.team : '')}</span></div>
      <span class="src ${l.src}">${esc(l.book)}</span>
      <label>${l.src === 'poly' ? 'Цена' : 'Кэф'} <input data-price="${i}" type="number" step="${l.src === 'poly' ? '0.001' : '0.01'}" value="${(+calc.prices[i]).toFixed(l.src === 'poly' ? 3 : 2)}"></label>
      <label>Ставка $ <input data-stake="${i}" type="number" step="1" value="${n.stakes[i].toFixed(2)}"></label>
      <div class="cl-out">${l.src === 'poly' ? `${(n.stakes[i] / (+calc.prices[i] * (1 + feePct / 100))).toFixed(1)} акций · комиссия ${feePct.toFixed(2)}%` : `выплата ${money(n.payouts[i])}`}
        ${l.depth ? `<br><span class="sub">в стакане до ${(l.depth.limit * 100).toFixed(1)}¢: ${money(l.depth.usd)}</span>` : ''}
        ${l.limit ? `<br><span class="sub">лимит бука ${Math.round(l.limit)}</span>` : ''}</div>
    </div>`;
  }).join('') + `<div class="calc-sum">
      <label>Итого $ <input id="calcBank" type="number" step="10" value="${n.total.toFixed(2)}"></label>
      <span>Выплата: <b>${money(Math.min(...n.payouts))}</b>${rub(Math.min(...n.payouts))}</span>
      <span>Профит: <b class="${n.profit >= 0 ? 'pos' : 'negv'}">${money(n.profit)} (${n.pct.toFixed(2)}%)</b>${rub(n.profit)}</span>
      ${a.maxBankroll != null && n.total > a.maxBankroll ? `<span class="warn">Больше лимита (${money(a.maxBankroll)})</span>` : ''}
    </div>`;
}

/* ---------------- journal ---------------- */
let journal = loadJournal();

function saveCalcToJournal() {
  if (!calc) return;
  const a = calc.arb, n = calcNumbers();
  journal.unshift({
    id: Date.now().toString(36), ts: Date.now(), event: a.match.title, sport: sportLabel(a.match.sport), profitPct: n.pct,
    legs: a.legs.map((l, i) => ({ book: l.book, label: `${l.label}${l.team && l.team !== l.label ? ' ' + l.team : ''}`, price: +(1 / n.qs[i]).toFixed(4), stake: +n.stakes[i].toFixed(2) })),
    status: 'pending',
  });
  saveJournal(journal);
  log('Сохранено в журнал', 'ok');
  renderJournal();
}

function renderJournal() {
  const from = $('#jFrom').value ? new Date($('#jFrom').value).getTime() : null;
  const to = $('#jTo').value ? new Date($('#jTo').value).getTime() + 86400e3 - 1 : null;
  const st = journalStats(journal, from, to);
  $('#jSummary').innerHTML = `
    <div class="stat"><span>Ставок</span><b>${st.entries.length}</b></div>
    <div class="stat"><span>Оборот</span><b>${money(st.turnover)}</b></div>
    <div class="stat"><span>Прибыль</span><b class="${st.profit >= 0 ? 'pos' : 'negv'}">${money(st.profit)}</b></div>
    <div class="stat"><span>Доходность</span><b>${st.roi.toFixed(2)}%</b></div>`;
  const days = [...st.byDay.entries()].sort();
  const maxAbs = Math.max(1, ...days.map(([, v]) => Math.abs(v)));
  $('#jChart').innerHTML = days.length ? days.map(([d, v]) => `<div class="bar-wrap" title="${d}: ${money(v)}"><div class="bar ${v >= 0 ? 'up' : 'down'}" style="height:${Math.max(2, Math.abs(v) / maxAbs * 100)}%"></div><span>${d.slice(5)}</span></div>`).join('') : '<span class="sub">Нет рассчитанных ставок</span>';
  $('#jBooks').innerHTML = [...st.byBook.entries()].sort((a, b) => b[1].turnover - a[1].turnover).map(([b, v]) =>
    `<div class="jb"><span>${esc(b)}</span><b class="${v.net >= 0 ? 'pos' : 'negv'}">${money(v.net)}</b><span class="sub">оборот ${money(v.turnover)}</span></div>`).join('') || '<span class="sub">—</span>';
  $('#jBody').innerHTML = st.entries.length ? st.entries.map(e => {
    const { total, pnl, settled } = entryPnl(e);
    return `<tr data-id="${e.id}">
      <td class="nowrap">${fmtTime(e.ts)}</td>
      <td><div class="ev">${esc(e.event)}</div><div class="sub">${esc(e.sport)} · ожид. ${money(expectedPnl(e))}</div></td>
      <td>${e.legs.map(l => `<div class="leg"><b>${esc(l.book)}</b> ${esc(l.label)} @ ${(+l.price).toFixed(2)} · ${money(l.stake)}</div>`).join('')}</td>
      <td class="nowrap">${money(total)}</td>
      <td><select data-status>${['pending', 'void', ...e.legs.map((_, i) => String(i))].map(v =>
        `<option value="${v}" ${String(e.status) === v ? 'selected' : ''}>${v === 'pending' ? 'Ожидает' : v === 'void' ? 'Возврат' : 'Зашла: ' + esc(e.legs[+v].book)}</option>`).join('')}</select></td>
      <td class="nowrap ${settled ? (pnl >= 0 ? 'pos' : 'negv') : 'sub'}">${settled ? money(pnl) : '—'}</td>
      <td><button class="ghost small" data-del>✕</button></td></tr>`;
  }).join('') : '<tr><td colspan="7" class="empty">Журнал пуст. Откройте калькулятор у вилки и нажмите «Сохранить в журнал».</td></tr>';
}

/* ---------------- wiring ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  fillForm();
  $('#scanBtn').addEventListener('click', () => runScan());
  $('#demoBtn').addEventListener('click', () => runScan({ demo: true }));
  $('#settingsForm').addEventListener('change', () => { readForm(); save(); schedule(); render(); });
  $('#search').addEventListener('input', () => { readForm(); save(); render(); });
  $$('[data-sort]').forEach(b => b.addEventListener('click', () => { S.sortBy = b.dataset.sort; save(); setSortButtons(); render(); }));
  $('#themeBtn').addEventListener('click', () => { S.theme = S.theme === 'light' ? 'dark' : 'light'; save(); applyTheme(); });
  $('#filtersBtn').addEventListener('click', () => {
    document.body.classList.toggle('aside-toggled');
    if (document.body.classList.contains('aside-toggled') && matchMedia('(max-width: 960px)').matches) $('aside').scrollIntoView({ behavior: 'smooth' });
  });
  $('#showHidden').addEventListener('click', () => { hidden.clear(); store.set(HIDDEN, []); render(); log('Скрытые события возвращены'); });
  $('#sportsOverride').addEventListener('change', renderSportChips);
  $('#resetSports').addEventListener('click', () => {
    $('#sportsOverride').value = JSON.stringify(DEFAULT_SPORTS, null, 1); readForm(); save(); renderSportChips();
  });
  $('#browserNotify').addEventListener('change', async e => {
    if (!e.target.checked) return;
    if (!('Notification' in window)) { log('Этот браузер не умеет уведомления. На iPhone — установите сайт на экран «Домой».', 'warn'); return; }
    const r = await Notification.requestPermission();
    if (r !== 'granted') { log('Уведомления запрещены в настройках браузера', 'warn'); e.target.checked = false; readForm(); save(); }
  });
  $('#notifyTest').addEventListener('click', async () => {
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    const ok = await notify('PolyArb · тест', 'Так будут выглядеть уведомления о вилках', null, 'test');
    log(ok ? 'Тестовое уведомление отправлено' : 'Уведомления недоступны: разрешите их в браузере (на iPhone — только из установленного приложения)', ok ? 'ok' : 'warn');
  });

  // installable app
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(e => log('Service worker: ' + e.message, 'warn'));
  }
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#installBtn').classList.remove('hidden'); });
  $('#installBtn').addEventListener('click', async () => {
    if (!installEvt) return;
    installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('#installBtn').classList.add('hidden');
  });
  $('#tgTest').addEventListener('click', async () => {
    readForm();
    if (!S.tgToken || !S.tgChat) return log('Укажите токен бота и chat id', 'warn');
    await sendTelegram(S.tgToken, S.tgChat, '✅ Тест: сканер вилок Polymarket ↔ букмекеры подключён');
    log('Тестовое сообщение отправлено в Telegram');
  });
  $('#papiCheck').addEventListener('click', async () => {
    readForm(); save();
    if (!S.oddspapiKey) return log('Вставьте ключ OddsPapi', 'warn');
    try {
      const p = new OddsPapi(S.oddspapiKey, { proxy: S.corsProxy });
      const acc = await p.account();
      const sub = Array.isArray(acc?.subscriptions) ? acc.subscriptions[0] : acc?.subscription || acc;
      log(`OddsPapi: ключ работает. ${sub?.request_count != null ? `Использовано ${sub.request_count} из ${sub.request_limit}` : JSON.stringify(acc).slice(0, 200)}`, 'ok');
      const books = await p.bookmakers();
      log(`OddsPapi: доступно букмекеров — ${books.length}: ${books.slice(0, 40).map(b => b.slug).join(', ')}${books.length > 40 ? '…' : ''}`);
    } catch (e) { log(e.message, 'error'); }
  });
  $('#papiDiag').addEventListener('click', async () => {
    readForm(); save();
    if (!S.oddspapiKey) return log('Вставьте ключ OddsPapi', 'warn');
    const sp = sports().find(x => x.kind === 'esports' && S.sports.includes(x.id)) || sports().find(x => x.kind === 'esports');
    $('#diagBox').classList.remove('hidden');
    $('#diagText').value = `Собираю отчёт по ${sp.label}…`;
    try {
      const p = new OddsPapi(S.oddspapiKey, { proxy: S.corsProxy });
      $('#diagText').value = (await p.diagnose(sp.papi)).split(S.oddspapiKey).join('***');
    } catch (e) { $('#diagText').value = 'Ошибка: ' + e.message.split(S.oddspapiKey).join('***'); }
  });
  $('#diagCopy').addEventListener('click', async () => {
    const t = $('#diagText');
    try { await navigator.clipboard.writeText(t.value); log('Отчёт скопирован', 'ok'); }
    catch { t.select(); document.execCommand('copy'); log('Отчёт скопирован', 'ok'); }
  });
  $('#clearAlerts').addEventListener('click', () => { alerted.clear(); store.set(SEEN, []); log('История уведомлений очищена'); });
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.toggle('active', x === t));
    $$('.panel').forEach(p => p.classList.toggle('hidden', p.id !== t.dataset.panel));
    if (t.dataset.panel === 'pJournal') renderJournal();
  }));

  // calculator
  $('#calcBody').addEventListener('input', e => {
    if (!calc) return;
    const t = e.target;
    if (t.dataset.price != null) { calc.prices[+t.dataset.price] = +t.value; calc.fixed = null; }
    else if (t.dataset.stake != null) { calc.fixed = { i: +t.dataset.stake, value: +t.value || 0 }; }
    else if (t.id === 'calcBank') { calc.bank = +t.value || 0; calc.fixed = null; }
    const focused = document.activeElement?.dataset; const fid = document.activeElement?.id;
    renderCalc();
    // keep focus on the field being edited
    const sel = fid === 'calcBank' ? '#calcBank' : focused?.price != null ? `[data-price="${focused.price}"]` : focused?.stake != null ? `[data-stake="${focused.stake}"]` : null;
    if (sel) { const el = $(sel); el.focus(); const v = el.value; el.value = ''; el.value = v; }
  });
  $('#calcSave').addEventListener('click', saveCalcToJournal);
  $('#calcClose').addEventListener('click', () => { calc = null; renderCalc(); render(); });

  // journal
  $('#jFrom').value = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10);
  $('#jFrom').addEventListener('change', renderJournal);
  $('#jTo').addEventListener('change', renderJournal);
  $$('[data-range]').forEach(b => b.addEventListener('click', () => {
    const d = +b.dataset.range;
    $('#jFrom').value = new Date(Date.now() - d * 86400e3).toISOString().slice(0, 10);
    $('#jTo').value = '';
    renderJournal();
  }));
  $('#jBody').addEventListener('change', e => {
    if (!e.target.matches('[data-status]')) return;
    const id = e.target.closest('tr').dataset.id;
    const en = journal.find(x => x.id === id);
    en.status = e.target.value; saveJournal(journal); renderJournal();
  });
  $('#jBody').addEventListener('click', e => {
    if (!e.target.matches('[data-del]')) return;
    const id = e.target.closest('tr').dataset.id;
    if (!confirm('Удалить запись из журнала?')) return;
    journal = journal.filter(x => x.id !== id); saveJournal(journal); renderJournal();
  });
  $('#jExport').addEventListener('click', () => {
    const blob = new Blob(['﻿' + toCSV(journal)], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'polyarb-journal.csv'; a.click();
  });

  setInterval(() => { if (state.arbs.length) render(); }, 60e3); // refresh "found N min ago"
  render();
});
