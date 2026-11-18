// Polymarket and Duel games in one shape, so the two can be compared market by market.
//
// game = { src, id, title, start: Date, teams: [name0, name1], url, tournament, markets: Map(key -> market) }
// market = { key, kind: 'win'|'hcp'|'total', scope: 'match'|'mapN', unit: 'maps'|'rounds', line,
//            outs: [side0, side1] }
//   win:   side i = team i wins
//   hcp:   line is the handicap of team 0; side 0 = team 0 with `line`, side 1 = team 1 with `-line`
//   total: side 0 = over `line`, side 1 = under `line`
// Lines are always .5, so the two sides of one market cover every result exactly once.
import { teamScore } from './names.js';

export const marketKey = (kind, scope, unit, line) => `${kind}|${scope}|${unit}|${kind === 'win' ? 0 : +line}`;
const isHalf = x => Number.isFinite(x) && Math.abs(Math.abs(x % 1) - 0.5) < 1e-9;
const parseArr = v => { if (Array.isArray(v)) return v; try { return JSON.parse(v || '[]'); } catch { return []; } };
const num = v => (v === undefined || v === null || v === '' || isNaN(+v) ? null : +v);

/* ------------------------------ Polymarket ------------------------------ */

const POLY_TYPES = [
  [/^moneyline$/, () => ({ kind: 'win', scope: 'match', unit: 'maps' })],
  [/^child_moneyline$/, m => { const n = mapNo(m.groupItemTitle || m.question); return n && { kind: 'win', scope: 'map' + n, unit: 'maps' }; }],
  [/^map_handicap$/, () => ({ kind: 'hcp', scope: 'match', unit: 'maps' })],
  [/^totals$/, m => /games|maps/i.test(`${m.groupItemTitle} ${m.question}`) && { kind: 'total', scope: 'match', unit: 'maps' }],
  [/^round_handicap_game_(\d+)$/, (m, g) => ({ kind: 'hcp', scope: 'map' + g[1], unit: 'rounds' })],
  [/^round_over_under_game_(\d+)$/, (m, g) => ({ kind: 'total', scope: 'map' + g[1], unit: 'rounds' })],
];
function mapNo(text) { const g = String(text || '').match(/\b(?:map|game)\s*(\d)\b/i); return g ? +g[1] : null; }

const feeOf = m => (m.feesEnabled && m.feeSchedule ? { rate: +m.feeSchedule.rate || 0, exponent: m.feeSchedule.exponent == null ? 1 : +m.feeSchedule.exponent } : null);

/** Index of a team in `teams` for an outcome name; exact name first, then a certain match only. */
function teamIndex(teams, name) {
  const n = String(name || '').trim();
  const exact = teams.findIndex(t => t === n);
  if (exact >= 0) return exact;
  const s = teams.map(t => teamScore(t, n));
  const best = s.indexOf(Math.max(...s));
  return s[best] === 1 && s[1 - best] < 1 ? best : -1;
}

/** One Gamma event -> game, or { skip: reason }. */
export function parsePolyEvent(ev, sportId, now = Date.now()) {
  const open = (ev.markets || []).filter(m => !m.closed && m.active !== false && m.acceptingOrders !== false);
  const main = (ev.markets || []).find(m => m.sportsMarketType === 'moneyline');
  if (!main) return { skip: 'нет рынка «победа в матче»' };
  const teams = parseArr(main.outcomes).map(s => String(s).trim());
  if (teams.length !== 2) return { skip: 'не два участника' };
  const start = parseDate(ev.startTime) || parseDate(main.gameStartTime);
  if (!start) return { skip: 'нет времени начала' };
  if (start.getTime() <= now) return { skip: 'матч уже начался' };

  const markets = new Map();
  for (const m of open) {
    const rule = POLY_TYPES.find(([re]) => re.test(m.sportsMarketType || ''));
    if (!rule) continue;
    const spec = rule[1](m, (m.sportsMarketType || '').match(rule[0]));
    if (!spec) continue;
    const outs = parseArr(m.outcomes).map(s => String(s).trim());
    const tokens = parseArr(m.clobTokenIds);
    if (outs.length !== 2 || tokens.length !== 2) continue;
    const fee = feeOf(m);
    const leg = (i, label) => ({
      token: tokens[i], label, fee, marketId: m.id, minSize: num(m.orderMinSize),
      // Gamma top of book, used only when the CLOB order book cannot be loaded
      gammaAsk: i === 0 ? num(m.bestAsk) : (num(m.bestBid) != null ? r4(1 - num(m.bestBid)) : null),
    });
    let line = 0, sides;
    if (spec.kind === 'total') {
      line = Math.abs(num(m.line));
      const over = outs.findIndex(o => /^over$/i.test(o)), under = outs.findIndex(o => /^under$/i.test(o));
      if (!isHalf(line) || over < 0 || under < 0) continue;
      sides = [leg(over, `Больше ${line}`), leg(under, `Меньше ${line}`)];
    } else {
      const idx = outs.map(o => teamIndex(teams, o));
      if (idx[0] < 0 || idx[1] < 0 || idx[0] === idx[1]) continue; // outcome names must be the two teams
      sides = [];
      if (spec.kind === 'hcp') {
        const l0 = num(m.line); // Polymarket quotes the handicap for outcomes[0]
        if (!isHalf(l0)) continue;
        line = idx[0] === 0 ? l0 : -l0;
      }
      outs.forEach((o, i) => {
        const t = idx[i];
        const l = spec.kind === 'hcp' ? (t === 0 ? line : -line) : null;
        sides[t] = leg(i, spec.kind === 'hcp' ? `${teams[t]} ${signed(l)}` : teams[t]);
      });
    }
    const key = marketKey(spec.kind, spec.scope, spec.unit, line);
    markets.set(key, { key, ...spec, line, outs: sides, question: m.groupItemTitle || m.question });
  }
  const full = String(ev.title || '').replace(/^[^:]{2,25}:\s*/, '');
  const cut = full.indexOf(' - ');
  return {
    src: 'poly', sport: sportId, id: String(ev.id), slug: ev.slug,
    title: (cut > 0 ? full.slice(0, cut) : full).replace(/\s*\(BO\d\)\s*$/i, ''),
    tournament: cut > 0 ? full.slice(cut + 3) : '',
    url: `https://polymarket.com/event/${ev.slug}`, start, teams, markets,
  };
}

/* --------------------------------- Duel --------------------------------- */

// DuelAPI market keys (Odds-API format, ids are the sportsbook's own):
//   m_186                      match winner
//   m_330_mapnr=N              map N winner
//   m_327_hcp=X                map handicap
//   m_328_total=X              total maps
//   m_331_mapnr=N|hcp=X        map N round handicap   (Counter-Strike)
//   m_332_mapnr=N|total=X      map N total rounds     (Counter-Strike)
const DUEL_TYPES = {
  186: () => ({ kind: 'win', scope: 'match', unit: 'maps' }),
  330: p => p.mapnr && { kind: 'win', scope: 'map' + p.mapnr, unit: 'maps' },
  327: () => ({ kind: 'hcp', scope: 'match', unit: 'maps' }),
  328: () => ({ kind: 'total', scope: 'match', unit: 'maps' }),
  331: p => p.mapnr && { kind: 'hcp', scope: 'map' + p.mapnr, unit: 'rounds' },
  332: p => p.mapnr && { kind: 'total', scope: 'map' + p.mapnr, unit: 'rounds' },
};

export function parseDuelKey(key) {
  const g = String(key).match(/^m_(\d+)(?:_(.*))?$/);
  if (!g) return null;
  const params = {};
  for (const kv of (g[2] || '').split('|')) { const [k, v] = kv.split('='); if (k) params[k] = v; }
  return { id: +g[1], params };
}

/** "FORZE Reload (-1.5)" -> { name: "FORZE Reload", line: -1.5 } */
export function splitLine(name) {
  const g = String(name).trim().match(/^(.*?)\s*\(([+-]?\d+(?:\.\d+)?)\)\s*$/);
  return g ? { name: g[1].trim(), line: +g[2] } : { name: String(name).trim(), line: null };
}

/** One DuelAPI event (with bookmakers) -> game, or { skip: reason }. */
export function parseDuelEvent(ev, now = Date.now()) {
  const start = parseDate(ev.commence_time);
  if (ev.live) return { skip: 'идёт (live)' };
  if (ev.status && ev.status !== 'Not started') return { skip: `идёт: ${ev.status}` };
  if (!start || start.getTime() <= now) return { skip: 'время начала прошло' };
  const teams = [String(ev.home_team || '').trim(), String(ev.away_team || '').trim()];
  const book = (ev.bookmakers || []).find(b => b.key === 'duel') || (ev.bookmakers || [])[0];
  const markets = new Map();
  for (const m of book?.markets || []) {
    const k = parseDuelKey(m.key);
    const spec = k && DUEL_TYPES[k.id]?.(k.params);
    if (!spec) continue;
    const outs = m.outcomes || [];
    if (outs.length !== 2 || outs.some(o => !(o.price > 1))) continue;
    let line = 0;
    const sides = [];
    if (spec.kind === 'total') {
      line = +k.params.total;
      if (!isHalf(line)) continue;
      for (const o of outs) {
        const g = String(o.name).trim().match(/^(over|under)\s+([\d.]+)$/i);
        if (!g || Math.abs(+g[2] - line) > 1e-9) continue;
        sides[/^over$/i.test(g[1]) ? 0 : 1] = { price: +o.price, label: o.name };
      }
    } else {
      const parsed = outs.map(o => ({ ...splitLine(o.name), price: +o.price, label: o.name }));
      const idx = parsed.map(p => teams.indexOf(p.name));
      if (idx.includes(-1) || idx[0] === idx[1]) continue; // outcomes must be exactly the two teams
      if (spec.kind === 'hcp') {
        const l = parsed.map(p => p.line);
        if (l.some(x => !isHalf(x)) || Math.abs(l[0] + l[1]) > 1e-9) continue; // must be +x / -x
        line = idx[0] === 0 ? l[0] : l[1];
      }
      parsed.forEach((p, i) => { sides[idx[i]] = { price: p.price, label: p.label }; });
    }
    if (!sides[0] || !sides[1]) continue;
    const key = marketKey(spec.kind, spec.scope, spec.unit, line);
    markets.set(key, { key, ...spec, line, outs: sides, duelKey: m.key });
  }
  if (!markets.size) return { skip: 'нет рынков на две команды (аутрайт или пусто)' };
  return {
    src: 'duel', id: String(ev.id), title: `${teams[0]} vs ${teams[1]}`, tournament: ev.tournament || '',
    url: ev.duel_url || 'https://duel.com/sports', start, teams, markets, updated: book?.last_update || null,
  };
}

/** DuelAPI /events item (no odds) — just enough to match games before paying for odds. */
export function duelEventStub(ev, now = Date.now()) {
  const start = parseDate(ev.commence_time);
  if (ev.live || (ev.status && ev.status !== 'Not started') || !start || start.getTime() <= now) return null;
  if (!ev.home_team || !ev.away_team) return null;
  return { src: 'duel', id: String(ev.id), title: `${ev.home_team} vs ${ev.away_team}`, start, teams: [ev.home_team.trim(), ev.away_team.trim()], tournament: ev.tournament || '', marketsCount: ev.markets_count || 0 };
}

/* -------------------------------- shared -------------------------------- */

export function parseDate(s) {
  if (!s) return null;
  const d = new Date(String(s).trim().replace(' ', 'T'));
  return isNaN(d) ? null : d;
}
const r4 = x => Math.round(x * 1e4) / 1e4;
export const signed = x => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x);

const SCOPE_RU = s => (s === 'match' ? 'матч' : `карта ${s.slice(3)}`);
export function marketLabel(m) {
  if (m.kind === 'win') return m.scope === 'match' ? 'Победа в матче' : `Победа на ${m.scope.slice(3)}-й карте`;
  if (m.kind === 'hcp') return m.unit === 'maps' ? 'Фора по картам' : `Фора по раундам (${SCOPE_RU(m.scope)})`;
  return m.unit === 'maps' ? 'Тотал карт' : `Тотал раундов (${SCOPE_RU(m.scope)})`;
}
