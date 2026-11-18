// Polymarket and Duel games in one shape, so the two can be compared market by market.
//
// game = { src, id, title, start: Date, teams: [name0, name1], url, tournament, profile, markets: Map(key -> market) }
// market = { key, kind, scope, unit, line, outs: [side0, side1] }
//   win:   side i = team i wins                               (scope: match | mapN | setN)
//   hcp:   line is the handicap of team 0; side 0 = team 0 with `line`, side 1 = team 1 with `-line`
//   total: side 0 = over `line`, side 1 = under `line`
//   x:     a three-way result (football): line 0 = team 0 wins, 1 = draw, 2 = team 1 wins;
//          side 0 = that result happens, side 1 = it does not
// Lines are .5 (or a three-way result), so the two sides of one market cover every result exactly once.
//
// Profiles (how a sport is priced on both sites):
//   esports     maps / rounds
//   soccer      90 minutes + stoppage time; goals
//   hockey      including overtime and shootout (NHL rules on Polymarket, "incl. overtime and penalties" on Duel)
//   basketball  including overtime; points
//   tennis      sets / games
import { teamScore } from './names.js';

export const marketKey = (kind, scope, unit, line) => `${kind}|${scope}|${unit}|${kind === 'win' ? 0 : +line}`;
const isHalf = x => Number.isFinite(x) && Math.abs(Math.abs(x % 1) - 0.5) < 1e-9;
const parseArr = v => { if (Array.isArray(v)) return v; try { return JSON.parse(v || '[]'); } catch { return []; } };
const num = v => (v === undefined || v === null || v === '' || isNaN(+v) ? null : +v);
const WIN_UNIT = { esports: 'maps' };
const winUnit = profile => WIN_UNIT[profile] || '-';

/* ------------------------------ Polymarket ------------------------------ */

const POLY_TYPES = {
  esports: [
    [/^moneyline$/, () => ({ kind: 'win', scope: 'match' })],
    [/^child_moneyline$/, m => { const n = numberIn(m.groupItemTitle || m.question, 'map|game'); return n && { kind: 'win', scope: 'map' + n }; }],
    [/^map_handicap$/, () => ({ kind: 'hcp', scope: 'match', unit: 'maps' })],
    [/^totals$/, m => /games|maps/i.test(`${m.groupItemTitle} ${m.question}`) && { kind: 'total', scope: 'match', unit: 'maps' }],
    [/^round_handicap_game_(\d+)$/, (m, g) => ({ kind: 'hcp', scope: 'map' + g[1], unit: 'rounds' })],
    [/^round_over_under_game_(\d+)$/, (m, g) => ({ kind: 'total', scope: 'map' + g[1], unit: 'rounds' })],
  ],
  hockey: [
    [/^moneyline$/, () => ({ kind: 'win', scope: 'match' })],
    [/^spreads$/, () => ({ kind: 'hcp', scope: 'match', unit: 'goals' })],
    [/^totals$/, () => ({ kind: 'total', scope: 'match', unit: 'goals' })],
  ],
  basketball: [
    [/^moneyline$/, () => ({ kind: 'win', scope: 'match' })],
    [/^spreads$/, () => ({ kind: 'hcp', scope: 'match', unit: 'points' })],
    [/^totals$/, () => ({ kind: 'total', scope: 'match', unit: 'points' })],
  ],
  tennis: [
    [/^moneyline$/, () => ({ kind: 'win', scope: 'match' })],
    [/^tennis_first_set_winner$/, () => ({ kind: 'win', scope: 'set1' })],
    [/^tennis_set_winner$/, m => num(m.line) && { kind: 'win', scope: 'set' + num(m.line) }],
    [/^tennis_set_handicap$/, () => ({ kind: 'hcp', scope: 'match', unit: 'sets' })],
    [/^tennis_game_handicap$/, () => ({ kind: 'hcp', scope: 'match', unit: 'games' })],
    [/^tennis_match_totals$/, () => ({ kind: 'total', scope: 'match', unit: 'games' })],
    [/^tennis_set_totals$/, () => ({ kind: 'total', scope: 'match', unit: 'sets' })],
  ],
  soccer: [ // the three-way result is read separately (three Yes/No markets)
    [/^spreads$/, () => ({ kind: 'hcp', scope: 'match', unit: 'goals' })],
    [/^totals$/, () => ({ kind: 'total', scope: 'match', unit: 'goals' })],
  ],
};
function numberIn(text, word) { const g = String(text || '').match(new RegExp(`\\b(?:${word})\\s*(\\d)\\b`, 'i')); return g ? +g[1] : null; }

const feeOf = m => (m.feesEnabled && m.feeSchedule ? { rate: +m.feeSchedule.rate || 0, exponent: m.feeSchedule.exponent == null ? 1 : +m.feeSchedule.exponent } : null);
// football markets settled with extra time or penalties are not the 90-minute result Duel prices
const BEYOND_90 = /extra[- ]time|penalt(y|ies) shoot|advance|qualif/i;

/** Index of a team in `teams` for an outcome name; exact name first, then a certain match only. */
function teamIndex(teams, name) {
  const n = String(name || '').trim();
  const exact = teams.findIndex(t => t === n);
  if (exact >= 0) return exact;
  const s = teams.map(t => teamScore(t, n));
  const best = s.indexOf(Math.max(...s));
  return s[best] === 1 && s[1 - best] < 1 ? best : -1;
}

function polyLeg(m, tokens, i, label) {
  return {
    token: tokens[i], label, fee: feeOf(m), marketId: m.id, minSize: num(m.orderMinSize),
    // Gamma top of book, used only when the CLOB order book cannot be loaded
    gammaAsk: i === 0 ? num(m.bestAsk) : (num(m.bestBid) != null ? r4(1 - num(m.bestBid)) : null),
  };
}

/** Teams of a football event from its title: "Manchester City FC vs. Fulham FC". */
function soccerTeams(ev) {
  const t = String(ev.title || '').replace(/\s+-\s+.*$/, '');
  const g = t.split(/\s+vs\.?\s+/i);
  return g.length === 2 ? g.map(s => s.trim()) : null;
}

/** One Gamma event -> game, or { skip: reason }. `sport` is a sport id (esports) or { id, profile }. */
export function parsePolyEvent(ev, sport, now = Date.now()) {
  const sportId = typeof sport === 'string' ? sport : sport.id;
  const profile = (typeof sport === 'object' && sport.profile) || 'esports';
  const open = (ev.markets || []).filter(m => !m.closed && m.active !== false && m.acceptingOrders !== false);
  let teams;
  if (profile === 'soccer') {
    teams = soccerTeams(ev);
    if (!teams) return { skip: 'не два участника' };
  } else {
    const main = (ev.markets || []).find(m => m.sportsMarketType === 'moneyline');
    if (!main) return { skip: 'нет рынка «победа в матче»' };
    teams = parseArr(main.outcomes).map(s => String(s).trim());
    if (teams.length !== 2 || /^yes$/i.test(teams[0])) return { skip: 'не два участника' };
  }
  const start = parseDate(ev.startTime) || parseDate(ev.markets?.[0]?.gameStartTime);
  if (!start) return { skip: 'нет времени начала' };
  if (start.getTime() <= now) return { skip: 'матч уже начался' };

  const markets = new Map();
  const add = (spec, line, sides, m) => {
    const key = marketKey(spec.kind, spec.scope, spec.unit || winUnit(profile), line);
    markets.set(key, { key, unit: winUnit(profile), ...spec, line, outs: sides, question: m.groupItemTitle || m.question });
  };
  for (const m of open) {
    const outs = parseArr(m.outcomes).map(s => String(s).trim());
    const tokens = parseArr(m.clobTokenIds);
    if (outs.length !== 2 || tokens.length !== 2) continue;
    if (profile === 'soccer' && BEYOND_90.test(m.description || '')) continue;
    // football result: "Will X win?" / "draw?" with Yes/No outcomes
    if (profile === 'soccer' && m.sportsMarketType === 'moneyline') {
      if (!/^yes$/i.test(outs[0]) || !/^no$/i.test(outs[1])) continue;
      const g = String(m.groupItemTitle || '');
      const x = /^draw\b/i.test(g) ? 1 : [0, 2][teamIndex(teams, g)];
      if (x == null) continue;
      const name = x === 1 ? 'Ничья' : teams[x / 2];
      add({ kind: 'x', scope: 'match', unit: 'goals' }, x, [polyLeg(m, tokens, 0, name), polyLeg(m, tokens, 1, `не ${name === 'Ничья' ? 'ничья' : name}`)], m);
      continue;
    }
    const rule = (POLY_TYPES[profile] || []).find(([re]) => re.test(m.sportsMarketType || ''));
    if (!rule) continue;
    const spec = rule[1](m, (m.sportsMarketType || '').match(rule[0]));
    if (!spec) continue;
    let line = 0, sides;
    if (spec.kind === 'total') {
      line = Math.abs(num(m.line));
      const over = outs.findIndex(o => /^over\b/i.test(o)), under = outs.findIndex(o => /^under\b/i.test(o));
      if (!isHalf(line) || over < 0 || under < 0) continue;
      sides = [polyLeg(m, tokens, over, `Больше ${line}`), polyLeg(m, tokens, under, `Меньше ${line}`)];
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
        sides[t] = polyLeg(m, tokens, i, spec.kind === 'hcp' ? `${teams[t]} ${signed(l)}` : teams[t]);
      });
    }
    add(spec, line, sides, m);
  }
  const full = String(ev.title || '').replace(/^[^:]{2,60}:\s*/, '');
  const cut = full.indexOf(' - ');
  return {
    src: 'poly', sport: sportId, profile, id: String(ev.id), slug: ev.slug,
    title: (cut > 0 ? full.slice(0, cut) : full).replace(/\s*\(BO\d\)\s*$/i, ''),
    tournament: cut > 0 ? full.slice(cut + 3) : '',
    url: `https://polymarket.com/event/${ev.slug}`, start, teams, markets,
  };
}

/**
 * Polymarket splits one football game into several events ("…", "… - More Markets", "… - Exact Score"…).
 * Games with the same teams and start are merged; the main event (shortest slug) gives the link.
 */
export function mergePolyGames(games) {
  const by = new Map();
  for (const g of games) {
    const k = `${g.sport}|${g.teams.join('|')}|${+g.start}`;
    const cur = by.get(k);
    if (!cur) { by.set(k, { ...g, markets: new Map(g.markets) }); continue; }
    for (const [key, m] of g.markets) if (!cur.markets.has(key)) cur.markets.set(key, m);
    if ((g.slug || '').length < (cur.slug || '').length) Object.assign(cur, { id: g.id, slug: g.slug, url: g.url, title: g.title, tournament: g.tournament || cur.tournament });
  }
  return [...by.values()];
}

/* --------------------------------- Duel --------------------------------- */

// DuelAPI market keys (Odds-API format; ids are the sportsbook's own, checked on live data 2026-11-18).
const DUEL_TYPES = {
  esports: {
    186: () => ({ kind: 'win', scope: 'match' }),                       // winner
    330: p => p.mapnr && { kind: 'win', scope: 'map' + p.mapnr },        // map N winner
    327: () => ({ kind: 'hcp', scope: 'match', unit: 'maps' }),         // map handicap
    328: () => ({ kind: 'total', scope: 'match', unit: 'maps' }),       // total maps
    331: p => p.mapnr && { kind: 'hcp', scope: 'map' + p.mapnr, unit: 'rounds' },   // CS map N round handicap
    332: p => p.mapnr && { kind: 'total', scope: 'map' + p.mapnr, unit: 'rounds' }, // CS map N total rounds
  },
  hockey: { // only the "incl. overtime and penalties" markets: the 60-minute ones settle differently
    406: () => ({ kind: 'win', scope: 'match' }),
    410: () => ({ kind: 'hcp', scope: 'match', unit: 'goals' }),
    412: () => ({ kind: 'total', scope: 'match', unit: 'goals' }),
  },
  basketball: { // "incl. overtime"
    219: () => ({ kind: 'win', scope: 'match' }),
    223: () => ({ kind: 'hcp', scope: 'match', unit: 'points' }),
    225: () => ({ kind: 'total', scope: 'match', unit: 'points' }),
  },
  tennis: {
    186: () => ({ kind: 'win', scope: 'match' }),
    202: p => p.setnr && { kind: 'win', scope: 'set' + p.setnr },        // set N winner
    188: () => ({ kind: 'hcp', scope: 'match', unit: 'sets' }),
    187: () => ({ kind: 'hcp', scope: 'match', unit: 'games' }),
    189: () => ({ kind: 'total', scope: 'match', unit: 'games' }),
    314: () => ({ kind: 'total', scope: 'match', unit: 'sets' }),
  },
  soccer: { // m_1 (1x2) and m_10 (double chance) are read together, see soccerResult()
    16: () => ({ kind: 'hcp', scope: 'match', unit: 'goals' }),
    18: () => ({ kind: 'total', scope: 'match', unit: 'goals' }),
  },
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

// Simulated games Duel lists next to real ones: "Chicago Bulls (E)", "NBA (24 min play)", "NHL ... (3x3 min)"...
const VIRTUAL_TOURNAMENT = /\(\s*\d+\s*(min|sec)\b|\(\s*\d+x\d+\s*min|min play|shootout \(|\(\d+ games?;|\(1 set\)|\bsrl\b|simulated|virtual/i;
const VIRTUAL_TEAM = /\((e|srl|virtual)\)\s*$/i;
export const isVirtual = ev => VIRTUAL_TOURNAMENT.test(ev.tournament || '') || VIRTUAL_TEAM.test(ev.home_team || '') || VIRTUAL_TEAM.test(ev.away_team || '');

/** Football 1x2 + double chance -> three "x" markets in Duel team order. */
function soccerResult(book, teams, extra) {
  const m1 = book.markets.find(m => m.key === 'm_1'), m10 = book.markets.find(m => m.key === 'm_10');
  if (!m1 || !m10) return [];
  const who = name => (/^draw$/i.test(String(name).trim()) ? 1 : [0, 2][teams.indexOf(String(name).trim())]);
  const single = new Map(), dbl = new Map();
  for (const o of m1.outcomes || []) { const x = who(o.name); if (x != null && o.price > 1) single.set(x, o); }
  for (const o of m10.outcomes || []) {
    const parts = String(o.name).split(/\s+or\s+/i).map(who);
    if (parts.length !== 2 || parts.includes(undefined) || !(o.price > 1)) continue;
    dbl.set(3 - parts[0] - parts[1], o); // the result NOT covered: 0+1+2 = 3
  }
  const out = [];
  for (const x of [0, 1, 2]) {
    const a = single.get(x), b = dbl.get(x);
    if (!a || !b) continue;
    out.push({
      key: marketKey('x', 'match', 'goals', x), kind: 'x', scope: 'match', unit: 'goals', line: x,
      outs: [{ price: +a.price, label: a.name, ...extra(a, m1) }, { price: +b.price, label: b.name, ...extra(b, m10) }], duelKey: 'm_1+m_10',
    });
  }
  return out;
}

/** One DuelAPI event (with bookmakers) -> game, or { skip: reason }. */
export function parseDuelEvent(ev, now = Date.now(), profile = 'esports') {
  const start = parseDate(ev.commence_time);
  if (ev.live) return { skip: 'идёт (live)' };
  if (ev.status && ev.status !== 'Not started') return { skip: `идёт: ${ev.status}` };
  if (!start || start.getTime() <= now) return { skip: 'время начала прошло' };
  if (isVirtual(ev)) return { skip: 'виртуальный матч' };
  const teams = [String(ev.home_team || '').trim(), String(ev.away_team || '').trim()];
  const book = (ev.bookmakers || []).find(b => b.key === 'duel') || (ev.bookmakers || [])[0];
  const markets = new Map();
  const extra = (o, m) => ({ open: num(o.open_price), move: num(o.move), updated: m.last_update || book.last_update || null });
  const types = DUEL_TYPES[profile] || {};
  for (const m of book?.markets || []) {
    const k = parseDuelKey(m.key);
    const spec = k && types[k.id]?.(k.params);
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
        sides[/^over$/i.test(g[1]) ? 0 : 1] = { price: +o.price, label: o.name, ...extra(o, m) };
      }
    } else {
      const parsed = outs.map(o => ({ ...splitLine(o.name), price: +o.price, label: o.name, ...extra(o, m) }));
      const idx = parsed.map(p => teams.indexOf(p.name));
      if (idx.includes(-1) || idx[0] === idx[1]) continue; // outcomes must be exactly the two teams
      if (spec.kind === 'hcp') {
        const l = parsed.map(p => p.line);
        if (l.some(x => !isHalf(x)) || Math.abs(l[0] + l[1]) > 1e-9) continue; // must be +x / -x
        line = idx[0] === 0 ? l[0] : l[1];
      }
      parsed.forEach((p, i) => { sides[idx[i]] = { price: p.price, label: p.label, open: p.open, move: p.move, updated: p.updated }; });
    }
    if (!sides[0] || !sides[1]) continue;
    const unit = spec.unit || winUnit(profile);
    const key = marketKey(spec.kind, spec.scope, unit, line);
    markets.set(key, { key, ...spec, unit, line, outs: sides, duelKey: m.key });
  }
  if (profile === 'soccer') for (const x of soccerResult(book || { markets: [] }, teams, extra)) markets.set(x.key, x);
  if (!markets.size) return { skip: 'нет рынков на две команды (аутрайт или пусто)' };
  return {
    src: 'duel', id: String(ev.id), title: `${teams[0]} vs ${teams[1]}`, tournament: ev.tournament || '', profile,
    url: ev.duel_url || 'https://duel.com/sports', start, teams, markets, updated: book?.last_update || null,
  };
}

/** DuelAPI /events item (no odds) — just enough to match games before paying for odds. */
export function duelEventStub(ev, now = Date.now()) {
  const start = parseDate(ev.commence_time);
  if (ev.live || (ev.status && ev.status !== 'Not started') || !start || start.getTime() <= now) return null;
  if (!ev.home_team || !ev.away_team || isVirtual(ev)) return null;
  if (/\bvs\b|winner|award|props/i.test(`${ev.away_team}`) && ev.home_team === ev.tournament) return null; // outrights
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

const SCOPE_RU = s => (s === 'match' ? 'матч' : s.startsWith('set') ? `${s.slice(3)}-й сет` : `карта ${s.slice(3)}`);
const UNIT_RU = { maps: 'карт', rounds: 'раундов', goals: 'голов', points: 'очков', sets: 'сетов', games: 'геймов' };
const HCP_RU = { maps: 'по картам', rounds: 'по раундам', goals: '', points: '', sets: 'по сетам', games: 'по геймам' };
export function marketLabel(m) {
  if (m.kind === 'x') return ['Исход: победа 1-й команды', 'Исход: ничья', 'Исход: победа 2-й команды'][m.line] + ' (90 мин)';
  if (m.kind === 'win') {
    if (m.scope === 'match') return 'Победа в матче';
    return m.scope.startsWith('set') ? `Победа в ${m.scope.slice(3)}-м сете` : `Победа на ${m.scope.slice(3)}-й карте`;
  }
  const where = m.scope === 'match' ? '' : ` (${SCOPE_RU(m.scope)})`;
  if (m.kind === 'hcp') return `Фора ${HCP_RU[m.unit] ?? ''}`.trim() + where;
  return `Тотал ${UNIT_RU[m.unit] || ''}`.trim() + where;
}
