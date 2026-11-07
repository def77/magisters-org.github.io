import { DEFAULT_SPORTS, DEFAULT_SETTINGS } from './config.js';
import { fetchPolymarket, fetchOdds, fetchBooks, parsePolyEvent, parseOddsEvent, sendTelegram } from './sources.js';
import { scan, applyDepth } from './scanner.js';
import { stakes } from './arb.js';
import { demoData, demoBooks } from './demo.js';

const $ = sel => document.querySelector(sel);
const LS = 'polyarb.settings.v1';
const SEEN = 'polyarb.alerted.v1';

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let S = { ...DEFAULT_SETTINGS, ...store.get(LS, {}) };
let state = { matches: [], unmatched: [], arbs: [], lastScan: null, busy: false, timer: null, credits: null };
const alerted = new Set(store.get(SEEN, []));

function sports() {
  if (S.sportsOverride.trim()) {
    try { const v = JSON.parse(S.sportsOverride); if (Array.isArray(v)) return v; } catch {}
  }
  return DEFAULT_SPORTS;
}

/* ---------------- logging ---------------- */
function log(msg, level = 'info') {
  const el = document.createElement('div');
  el.className = 'log-' + level;
  el.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  const box = $('#log');
  box.prepend(el);
  while (box.children.length > 200) box.lastChild.remove();
}

/* ---------------- settings form ---------------- */
const FIELDS = ['oddsApiKey', 'regions', 'bookmakers', 'minProfit', 'minLiquidity', 'polyFee', 'exchangeCommission',
  'bankroll', 'timeTolerance', 'matchThreshold', 'refreshSec', 'includeBookOnly', 'useOrderBook', 'corsProxy',
  'tgToken', 'tgChat', 'browserNotify', 'sportsOverride'];

function renderSportChips() {
  const box = $('#sports');
  box.innerHTML = '';
  for (const sp of sports()) {
    const id = 'sp-' + sp.id;
    const lab = document.createElement('label');
    lab.className = 'chip';
    lab.innerHTML = `<input type="checkbox" id="${id}" ${S.sports.includes(sp.id) ? 'checked' : ''}><span>${esc(sp.label)}</span>`;
    lab.querySelector('input').addEventListener('change', e => {
      S.sports = e.target.checked ? [...new Set([...S.sports, sp.id])] : S.sports.filter(x => x !== sp.id);
      save();
    });
    box.append(lab);
  }
}

function fillForm() {
  for (const f of FIELDS) {
    const el = document.getElementById(f);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!S[f]; else el.value = S[f] ?? '';
  }
  renderSportChips();
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

/* ---------------- scanning ---------------- */
async function runScan({ demo = false } = {}) {
  if (state.busy) return;
  readForm(); save();
  const active = sports().filter(sp => S.sports.includes(sp.id));
  if (!active.length) return log('Выберите хотя бы один вид спорта', 'warn');
  if (!demo && !S.oddsApiKey) {
    log('Нужен ключ The Odds API (бесплатно на the-odds-api.com). Запускаю демо-режим.', 'warn');
    demo = true;
  }
  state.busy = true;
  setStatus(demo ? 'Демо-скан…' : 'Сканирую…', 'busy');
  $('#scanBtn').disabled = true;

  try {
    let polyGames = [], oddsBySport = {};
    if (demo) {
      const d = demoData();
      for (const sp of active) {
        polyGames.push(...(d.gamma[sp.id] || []).map(e => parsePolyEvent(e, sp)).filter(Boolean));
        oddsBySport[sp.id] = (d.odds[sp.id] || []).map(parseOddsEvent);
      }
      log(`Демо: ${polyGames.length} матчей Polymarket`);
    } else {
      const jobs = active.map(async sp => {
        const [p, o] = await Promise.allSettled([fetchPolymarket(sp, S.corsProxy, log), fetchOdds(sp, S, log)]);
        if (p.status === 'fulfilled') polyGames.push(...p.value);
        else log(`Polymarket ${sp.label}: ${p.reason.message}`, 'error');
        if (o.status === 'fulfilled') { oddsBySport[sp.id] = o.value.events; if (o.value.remaining) state.credits = o.value.remaining; }
        else log(`Букмекеры ${sp.label}: ${o.reason.message}`, 'error');
      });
      await Promise.all(jobs);
    }

    const res = scan(polyGames, oddsBySport, S);
    let arbs = res.matches.flatMap(m => m.arbs.map(a => ({ ...a, legs: a.legs.map(l => ({ ...l })), match: m })));

    if (S.useOrderBook && arbs.length) {
      const tokens = arbs.flatMap(a => a.legs.filter(l => l.src === 'poly').map(l => l.token));
      try {
        const books = demo ? demoBooks(tokens, polyGames) : await fetchBooks(tokens, S.corsProxy);
        arbs.forEach(a => applyDepth(a, books, S));
        log(`Стаканы CLOB: ${books.size} токенов`);
      } catch (e) { log('Стаканы CLOB: ' + e.message, 'error'); }
      arbs = arbs.filter(a => a.profitPct >= S.minProfit);
    }
    arbs = arbs.filter(a => !S.minLiquidity || a.maxBankroll == null || a.maxBankroll >= S.minLiquidity);
    arbs.sort((a, b) => b.profitPct - a.profitPct);

    state = { ...state, matches: res.matches, unmatched: res.unmatched, arbs, lastScan: new Date(), demo };
    log(`Готово: сопоставлено ${res.matches.length}, без пары ${res.unmatched.length}, вилок ${arbs.length}`, arbs.length ? 'ok' : 'info');
    render();
    if (!demo) await alertNew(arbs);
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

function schedule() {
  clearTimeout(state.timer);
  if (S.refreshSec >= 15) state.timer = setTimeout(() => runScan({ demo: state.demo }), S.refreshSec * 1000);
}

/* ---------------- alerts ---------------- */
const arbKey = a => a.match.poly.id + '|' + a.legs.map(l => `${l.bookKey}:${l.side}:${l.set.join('')}`).join('/');

async function alertNew(arbs) {
  const fresh = arbs.filter(a => !alerted.has(arbKey(a)));
  if (!fresh.length) return;
  fresh.forEach(a => alerted.add(arbKey(a)));
  store.set(SEEN, [...alerted].slice(-500));
  beep();
  for (const a of fresh.slice(0, 10)) {
    const text = `🟢 <b>${a.profitPct.toFixed(2)}%</b> ${esc(a.match.poly.title)}\n` +
      a.legs.map(l => `• ${esc(l.book)} — ${esc(l.label)} @ ${fmtPrice(l)}`).join('\n') +
      (a.maxBankroll ? `\nЛимит ≈ $${Math.round(a.maxBankroll)}` : '') + `\n${a.match.poly.url}`;
    if (S.tgToken && S.tgChat) sendTelegram(S.tgToken, S.tgChat, text).catch(e => log('Telegram: ' + e.message, 'error'));
    if (S.browserNotify && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(`Вилка ${a.profitPct.toFixed(2)}%`, { body: a.match.poly.title });
    }
  }
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 880; g.gain.value = 0.05;
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.15);
  } catch {}
}

/* ---------------- rendering ---------------- */
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const fmtPrice = l => l.src === 'poly' ? `${(l.price * 100).toFixed(1)}¢ (${(1 / l.price).toFixed(2)})` : l.price.toFixed(2);
const fmtTime = d => d ? d.toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const money = v => '$' + (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2));
const sportLabel = id => sports().find(s => s.id === id)?.label || id;

function render() {
  const { arbs, matches, unmatched } = state;
  $('#statArbs').textContent = arbs.length;
  $('#statBest').textContent = arbs[0] ? arbs[0].profitPct.toFixed(2) + '%' : '—';
  $('#statMatched').textContent = matches.length;
  $('#statCredits').textContent = state.credits ?? '—';
  $('#tabArbsCount').textContent = arbs.length;
  $('#tabMatchCount').textContent = matches.length;
  $('#tabUnmatchedCount').textContent = unmatched.length;
  renderArbs(); renderMatches(); renderUnmatched();
}

function renderArbs() {
  const tb = $('#arbBody');
  if (!state.arbs.length) {
    tb.innerHTML = `<tr><td colspan="6" class="empty">${state.lastScan ? 'Вилок выше порога нет. Снизьте «Мин. профит» или посмотрите вкладку «Сопоставленные».' : 'Нажмите «Сканировать» или «Демо».'}</td></tr>`;
    return;
  }
  tb.innerHTML = '';
  state.arbs.forEach((a, idx) => {
    const g = a.match.poly;
    const tr = document.createElement('tr');
    tr.className = 'arb-row';
    tr.innerHTML = `
      <td><span class="profit ${a.profitPct >= 2 ? 'hot' : ''}">${a.profitPct.toFixed(2)}%</span></td>
      <td><div class="ev">${esc(g.title)}</div><div class="sub">${esc(sportLabel(g.sport))} · ${esc(a.match.odds.title)} · совпадение ${(a.match.score * 100).toFixed(0)}%</div></td>
      <td class="nowrap">${fmtTime(g.start || a.match.odds.start)}</td>
      <td>${a.legs.map(l => `<div class="leg"><span class="src ${l.src}">${esc(l.book)}</span> ${esc(l.label)} <b>${fmtPrice(l)}</b></div>`).join('')}</td>
      <td class="nowrap">${a.maxBankroll != null ? money(a.maxBankroll) : '—'}</td>
      <td><button class="ghost" data-i="${idx}">Калькулятор</button></td>`;
    const calc = document.createElement('tr');
    calc.className = 'calc-row hidden';
    calc.innerHTML = `<td colspan="6">${calcHTML(a, S.bankroll)}</td>`;
    tr.querySelector('button').addEventListener('click', () => calc.classList.toggle('hidden'));
    calc.addEventListener('input', e => {
      if (e.target.matches('.bank')) calc.querySelector('.calc-body').innerHTML = calcBody(a, +e.target.value || 0);
    });
    tb.append(tr, calc);
  });
}

function calcHTML(a, bank) {
  return `<div class="calc"><label>Банк, $ <input class="bank" type="number" min="0" step="10" value="${bank}"></label>
    <a class="link" href="${a.match.poly.url}" target="_blank" rel="noopener">Открыть на Polymarket ↗</a>
    <div class="calc-body">${calcBody(a, bank)}</div></div>`;
}

function calcBody(a, bank) {
  const st = stakes(a, bank);
  const rows = st.legs.map(l => `<tr>
      <td><span class="src ${l.src}">${esc(l.book)}</span></td>
      <td>${esc(l.label)}${l.side === 'NO' ? ' <span class="tag">NO</span>' : ''}</td>
      <td>${fmtPrice(l)}</td>
      <td><b>${money(l.stake)}</b></td>
      <td>${l.shares != null ? `${l.shares.toFixed(1)} акций` : `выплата ${money(l.stake / l.q)}${Math.abs(1 / l.q - l.price) > 1e-9 ? ' (после комиссии)' : ''}`}</td>
      <td>${l.depth ? `в стакане до ${(l.depth.limit * 100).toFixed(1)}¢: ${money(l.depth.usd)}` : ''}</td></tr>`).join('');
  const warn = a.maxBankroll != null && bank > a.maxBankroll
    ? `<div class="warn">Банк больше доступной ликвидности (${money(a.maxBankroll)}) — цена на Polymarket уйдёт.</div>` : '';
  return `<table class="mini"><thead><tr><th>Площадка</th><th>Исход</th><th>Цена</th><th>Ставка</th><th></th><th>Ликвидность</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="calc-sum">Выплата при любом исходе: <b>${money(st.payout)}</b> · Профит: <b class="pos">${money(st.profit)}</b> (${a.profitPct.toFixed(2)}%)</div>${warn}`;
}

function renderMatches() {
  const tb = $('#matchBody');
  const rows = [...state.matches].sort((a, b) => (a.best?.sum ?? 9) - (b.best?.sum ?? 9));
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">Нет данных</td></tr>'; return; }
  tb.innerHTML = rows.map(m => {
    const n = m.poly.outcomes.length;
    const cells = m.poly.outcomes.map((o, i) => {
      const books = m.quotes.filter(q => q.src === 'book' && q.set.length === 1 && q.set[0] === i);
      const bestB = books.sort((a, b) => b.price - a.price)[0];
      return `<div class="leg"><b>${esc(o.name)}</b> · PM ${o.yes?.ask ? (o.yes.ask * 100).toFixed(1) + '¢ (' + (1 / o.yes.ask).toFixed(2) + ')' : '—'}
        · бук ${bestB ? bestB.price.toFixed(2) + ' <span class="sub">' + esc(bestB.book) + '</span>' : '—'}</div>`;
    }).join('');
    const margin = m.best ? (m.best.sum - 1) * 100 : null;
    return `<tr><td><div class="ev"><a class="link" href="${m.poly.url}" target="_blank" rel="noopener">${esc(m.poly.title)}</a></div>
      <div class="sub">${esc(sportLabel(m.poly.sport))} · ${esc(m.odds.title)} · ${(m.score * 100).toFixed(0)}% · ${n === 3 ? '1X2' : 'ML'}</div></td>
      <td class="nowrap">${fmtTime(m.poly.start || m.odds.start)}</td>
      <td>${cells}</td>
      <td class="nowrap">${m.odds.books.length}</td>
      <td class="nowrap"><span class="${margin != null && margin < 0 ? 'pos' : 'neg'}">${margin != null ? (margin < 0 ? '+' + (-margin).toFixed(2) + '% вилка' : 'маржа ' + margin.toFixed(2) + '%') : '—'}</span></td></tr>`;
  }).join('');
}

function renderUnmatched() {
  const tb = $('#unmatchedBody');
  if (!state.unmatched.length) { tb.innerHTML = '<tr><td colspan="3" class="empty">Все матчи сопоставлены</td></tr>'; return; }
  tb.innerHTML = state.unmatched.map(g => `<tr><td><a class="link" href="${g.url}" target="_blank" rel="noopener">${esc(g.title)}</a></td>
    <td>${esc(sportLabel(g.sport))}</td><td>${g.outcomes.map(o => esc(o.name)).join(' / ')}</td></tr>`).join('');
}

function setStatus(text, cls) {
  const el = $('#status');
  el.textContent = text; el.className = 'status ' + cls;
}

/* ---------------- wiring ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  fillForm();
  $('#scanBtn').addEventListener('click', () => runScan());
  $('#demoBtn').addEventListener('click', () => runScan({ demo: true }));
  $('#settingsForm').addEventListener('change', () => { readForm(); save(); schedule(); });
  $('#sportsOverride').addEventListener('change', renderSportChips);
  $('#resetSports').addEventListener('click', () => {
    $('#sportsOverride').value = JSON.stringify(DEFAULT_SPORTS, null, 1); readForm(); save(); renderSportChips();
  });
  $('#browserNotify').addEventListener('change', e => {
    if (e.target.checked && 'Notification' in window) Notification.requestPermission();
  });
  $('#tgTest').addEventListener('click', async () => {
    readForm();
    if (!S.tgToken || !S.tgChat) return log('Укажите токен бота и chat id', 'warn');
    await sendTelegram(S.tgToken, S.tgChat, '✅ Тест: сканер вилок Polymarket ↔ букмекеры подключён');
    log('Тестовое сообщение отправлено в Telegram');
  });
  $('#clearAlerts').addEventListener('click', () => { alerted.clear(); store.set(SEEN, []); log('История уведомлений очищена'); });
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('hidden', p.id !== t.dataset.panel));
  }));
  render();
});
