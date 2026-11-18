import { DuelApi, polyEvents, polyBooks } from './api.js';
import { parsePolyEvent, parseDuelEvent, duelEventStub } from './markets.js';
import { matchGames, comparePair } from './compare.js';

// Polymarket series id  <->  Duel sport (found by title in /v4/sports)
const SPORTS = [
  { id: 'cs2', label: 'Counter-Strike 2', series: 10310, duel: /^counter-strike$/i },
  { id: 'dota2', label: 'Dota 2', series: 10309, duel: /^dota 2$/i },
  { id: 'lol', label: 'League of Legends', series: 10311, duel: /^league of legends$/i },
  { id: 'val', label: 'Valorant', series: 10369, duel: /^valorant$/i },
];
const DEFAULTS = {
  duelKey: '', sports: ['cs2', 'dota2', 'lol', 'val'], bankroll: 100, minProfit: 0, maxProfit: 8, maxAgeMin: 10,
  extraPolyPct: 0, horizonH: 24, maxDuelEvents: 15, refreshMin: 0,
};
const FIELDS = ['duelKey', 'bankroll', 'minProfit', 'maxProfit', 'maxAgeMin', 'extraPolyPct', 'horizonH', 'maxDuelEvents', 'refreshMin'];
const LS = 'duelpoly.settings.v1';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let S = { ...DEFAULTS, ...load() };
let state = { rows: [], pairs: [], doubt: [], alone: [], busy: false, timer: null };

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
    S[f] = el.type === 'number' || el.tagName === 'SELECT' ? (el.value === '' ? DEFAULTS[f] : +el.value) : el.value.trim();
  }
  S.sports = $$('#sports input:checked').map(i => i.value);
  save(); costNote(); schedule();
}
function costNote() {
  const n = S.sports.length, m = S.maxDuelEvents;
  $('#costNote').textContent = `Скан ≈ ${5 * n} кр. за списки матчей + до ${10 * m} кр. за коэффициенты (5–10 кр. на матч). Бесплатно 200 кр./мес, Starter $9 — 250 000.`;
}

/* ----------------------------------- log ---------------------------------- */
function log(msg, cls = '') {
  const el = $('#log');
  const line = document.createElement('div');
  line.className = cls;
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  el.prepend(line);
  while (el.childNodes.length > 300) el.lastChild.remove();
}
function setStatus(t, cls = '') { const el = $('#status'); el.textContent = t; el.className = 'status ' + cls; }

/* ---------------------------------- scan ---------------------------------- */
async function scan() {
  if (state.busy) return;
  readForm();
  if (!S.duelKey) { setStatus('Нужен ключ DuelAPI', 'error'); log('Вставьте ключ DuelAPI слева', 'warn'); return; }
  const active = SPORTS.filter(sp => S.sports.includes(sp.id));
  if (!active.length) { setStatus('Выберите дисциплину', 'error'); return; }
  state.busy = true; $('#scanBtn').disabled = true; setStatus('Сканирую…', 'busy');
  const api = new DuelApi(S.duelKey, { log });
  const rows = [], pairsAll = [], doubtAll = [], aloneAll = [];
  try {
    const duelSports = await api.sports();
    const horizon = Date.now() + S.horizonH * 3600e3;
    let budget = Math.max(1, S.maxDuelEvents | 0);
    for (const sp of active) {
      const dSport = duelSports.find(x => sp.duel.test(x.title || ''));
      let poly;
      try {
        poly = (await polyEvents(sp.series)).map(e => parsePolyEvent(e, sp.id)).filter(g => !g.skip && g.markets.size && g.start <= horizon);
      } catch (e) { log(`Polymarket ${sp.label}: ${e.message}`, 'error'); continue; }
      if (!dSport || !dSport.events) { log(`${sp.label}: на Duel сейчас нет матчей`); aloneAll.push(...poly); continue; }
      if (!poly.length) { log(`${sp.label}: на Polymarket нет предстоящих матчей в ближайшие ${S.horizonH} ч`); continue; }

      const evs = await api.events(dSport.key);
      const stubs = evs.map(e => duelEventStub(e)).filter(e => e && e.start <= horizon + 3 * 3600e3);
      const { pairs, doubt, unmatched } = matchGames(poly, stubs);
      doubtAll.push(...doubt); aloneAll.push(...unmatched);
      pairs.sort((a, b) => a.poly.start - b.poly.start);
      const take = pairs.slice(0, budget);
      budget -= take.length;
      if (pairs.length > take.length) log(`${sp.label}: сопоставлено ${pairs.length}, коэффициенты беру для ближайших ${take.length} (настройка «Не больше матчей Duel»)`, 'warn');
      log(`${sp.label}: Polymarket ${poly.length}, Duel ${stubs.length}, пар ${pairs.length}, под вопросом ${doubt.length}`);
      if (!take.length) { pairsAll.push(...pairs.map(p => ({ ...p, common: null }))); continue; }

      const full = await api.oddsFor(dSport.key, take.map(p => p.duel.id), evs.map(e => String(e.id)));
      const byId = new Map(full.filter(Boolean).map(e => [String(e.id), e]));
      const ready = [];
      for (const p of take) {
        const d = byId.get(p.duel.id) && parseDuelEvent(byId.get(p.duel.id));
        if (!d || d.skip) { log(`${p.poly.title}: Duel — ${d?.skip || 'нет коэффициентов'}`); pairsAll.push({ ...p, common: 0 }); continue; }
        ready.push({ ...p, duel: d });
      }
      const tokens = ready.flatMap(p => [...p.poly.markets.values()].filter(m => p.duel.markets.size).flatMap(m => m.outs.map(o => o.token)));
      let books = null;
      try { books = await polyBooks(tokens); } catch (e) { log('Стаканы Polymarket: ' + e.message + ' — беру цены из Gamma', 'warn'); }
      for (const p of ready) {
        const r = comparePair(p, books, S);
        rows.push(...r);
        pairsAll.push({ ...p, common: new Set(r.map(x => x.market.key)).size });
      }
      for (const p of pairs.slice(take.length)) pairsAll.push({ ...p, common: null });
    }
    state = { ...state, rows, pairs: pairsAll, doubt: doubtAll, alone: aloneAll };
    const arbs = rows.filter(r => r.arb && r.profitPct >= S.minProfit);
    log(`Готово: пар ${pairsAll.length}, сравнений ${rows.length}, вилок ${arbs.length}. Потрачено ~${api.spent} кр.`, arbs.length ? 'ok' : '');
    setStatus(`Обновлено ${new Date().toLocaleTimeString()} · вилок ${arbs.length}`, 'ok');
    try { const a = await api.account(); $('#credits').textContent = `кредитов: ${a.credits?.remaining ?? '?'}`; } catch {}
    render();
  } catch (e) {
    log(e.message, 'error'); setStatus('Ошибка — см. «Лог»', 'error');
  } finally {
    state.busy = false; $('#scanBtn').disabled = false; schedule();
  }
}

function schedule() {
  clearTimeout(state.timer);
  if (S.refreshMin > 0) state.timer = setTimeout(scan, S.refreshMin * 60e3);
}

/* --------------------------------- render --------------------------------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = x => '$' + (x >= 100 ? x.toFixed(0) : x.toFixed(2));
const when = d => d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const gameCell = r => `<div><a href="${esc(r.poly.url)}" target="_blank" rel="noopener">${esc(r.poly.title)}</a></div><div class="sub">${when(r.poly.start)} · ${esc(r.poly.tournament || r.duel.tournament)}</div>`;

function render() {
  const arbs = state.rows.filter(r => r.arb && r.profitPct >= S.minProfit).sort((a, b) => b.profitPct - a.profitPct);
  $('#nArbs').textContent = arbs.length;
  $('#nAll').textContent = state.rows.length;
  $('#nGames').textContent = state.pairs.length;

  $('#arbBody').innerHTML = arbs.length ? arbs.map(r => `<tr>
      <td><div class="profit ${r.suspicious ? 'sus' : ''}">+${r.profitPct.toFixed(2)}%</div><div class="sub">+${usd(r.profitUsd)} с ${usd(S.bankroll)}</div>${r.suspicious ? '<span class="tag warn">проверь руками</span>' : ''}</td>
      <td>${gameCell(r)}</td>
      <td>${esc(r.label)}</td>
      <td><span class="tag poly">Polymarket</span><span class="side-name">${esc(r.pSide)}</span><br>
          цена <b>${r.polyLeg.price.toFixed(3)}</b> <span class="sub">(с комиссией ${r.qPoly.toFixed(4)})</span><br>
          купить <b>${r.polyShares.toFixed(1)}</b> акций ≈ <b>${usd(r.polyUsd)}</b>${r.belowMin ? ` <span class="tag warn">мин. ${r.belowMin} акций</span>` : ''}
          <div class="sub"><a href="${esc(r.poly.url)}" target="_blank" rel="noopener">открыть рынок</a></div></td>
      <td><span class="tag duel">Duel</span><span class="side-name">${esc(r.duelLeg.label)}</span><br>
          кэф <b>${r.duelLeg.price}</b><br>
          поставить <b>${usd(r.duelStake)}</b>
          <div class="sub"><a href="${esc(r.duel.url)}" target="_blank" rel="noopener">открыть на Duel</a>${r.duel.updated ? ` · кэф от ${new Date(r.duel.updated).toLocaleTimeString()}` : ''}</div></td>
      <td>${r.maxBank != null ? `до <b>${usd(r.maxBank)}</b> банка<div class="sub">${r.maxShares.toFixed(0)} акций в стакане</div>${r.bankTooBig ? '<span class="tag warn">банк больше стакана</span>' : ''}` : '—'}</td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty">${state.rows.length ? 'Вилок нет. Ближайшие к вилке — во вкладке «Все сравнения».' : 'Нажмите «Сканировать».'}</td></tr>`;

  const all = [...state.rows].sort((a, b) => a.sum - b.sum);
  $('#allBody').innerHTML = all.length ? all.map(r => `<tr class="${r.problems.length ? 'off' : ''}">
      <td class="${r.arb ? 'sum-good' : ''}">${r.sum.toFixed(4)}</td>
      <td>${gameCell(r)}</td>
      <td>${esc(r.label)}</td>
      <td>${esc(r.pSide)} <b>${r.polyLeg.price.toFixed(3)}</b></td>
      <td>${esc(r.duelLeg.label)} <b>@${r.duelLeg.price}</b></td>
      <td class="sub">${esc(r.problems.join('; ') || (r.arb ? `вилка +${r.profitPct.toFixed(2)}%` : `маржа ${(r.sum * 100 - 100).toFixed(1)}%`))}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">Пока пусто.</td></tr>';

  $('#pairBody').innerHTML = state.pairs.length ? [...state.pairs].sort((a, b) => a.poly.start - b.poly.start).map(p => `<tr>
      <td>${when(p.poly.start)}</td><td><a href="${esc(p.poly.url)}" target="_blank" rel="noopener">${esc(p.poly.title)}</a></td>
      <td>${esc(p.duel.title)}${p.perm[0] === 1 ? ' <span class="sub">(команды в обратном порядке)</span>' : ''}</td>
      <td>${p.common == null ? '<span class="sub">не загружали (лимит)</span>' : p.common}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">—</td></tr>';
  $('#doubtBody').innerHTML = state.doubt.length ? state.doubt.map(d => `<tr>
      <td>${when(d.poly.start)}</td><td>${esc(d.poly.title)}</td><td>${esc(d.duel.title)} <span class="sub">${when(d.duel.start)}</span></td><td class="sub">${esc(d.why)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">—</td></tr>';
  $('#aloneBody').innerHTML = state.alone.length ? [...state.alone].sort((a, b) => a.start - b.start).map(g => `<tr>
      <td>${when(g.start)}</td><td><a href="${esc(g.url)}" target="_blank" rel="noopener">${esc(g.title)}</a></td></tr>`).join('') : '<tr><td colspan="2" class="empty">—</td></tr>';
}

/* ---------------------------------- wire ---------------------------------- */
$$('.tab').forEach(b => b.addEventListener('click', () => {
  $$('.tab').forEach(x => x.classList.toggle('active', x === b));
  $$('.panel').forEach(p => p.classList.toggle('hidden', p.id !== 'tab-' + b.dataset.tab));
}));
document.addEventListener('change', e => { if (e.target.closest('.side')) { readForm(); render(); } });
$('#scanBtn').addEventListener('click', scan);
fillForm();
render();
