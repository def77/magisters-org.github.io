// Esports: Polymarket (Gamma) markets vs bookmaker lines from OddsPapi.
// Markets are compared on a common key  type|period|line  where
//   type   ml (winner), hcp (handicap), total (over/under)
//   period result (whole match) or pN (map N)
//   line   hcp: handicap of team 0 (Polymarket order), total: the total line, ml: 0
import { similarity } from './match.js';
import { findArbs, polyCost, bookCost } from './arb.js';
import { parseDate } from './sources.js';
import { EXCHANGE_KEYS } from './config.js';

const parseArr = v => { if (Array.isArray(v)) return v; try { return JSON.parse(v || '[]'); } catch { return []; } };
const num = v => (v === undefined || v === null || v === '' || isNaN(+v) ? null : +v);
const r2 = x => Math.round(x * 100) / 100;
export const marketKey = (type, period, line) => `${type}|${period}|${type === 'ml' ? 0 : r2(line)}`;

const feeOf = m => (m.feesEnabled && m.feeSchedule ? { rate: +m.feeSchedule.rate || 0, exponent: +m.feeSchedule.exponent || 1 } : null);
const periodFrom = text => { const n = String(text || '').match(/\b(?:map|game)\s*(\d+)/i); return n ? 'p' + n[1] : null; };

/** One Gamma event -> { teams:[a,b], start, markets:[{key,type,period,line,legs:[{ask,token,fee}x2]}] } */
export function parseGammaEsports(ev, sport) {
  const open = (ev.markets || []).filter(m => !m.closed && m.active !== false && m.acceptingOrders !== false);
  const main = open.find(m => m.sportsMarketType === 'moneyline');
  if (!main) return null;
  const teams = parseArr(main.outcomes).map(s => String(s).trim());
  if (teams.length !== 2) return null;
  const start = parseDate(ev.startTime) || parseDate(main.gameStartTime);
  const markets = [];
  for (const m of open) {
    const t = m.sportsMarketType || '';
    let type, period;
    if (t === 'moneyline') { type = 'ml'; period = 'result'; }
    else if (t === 'child_moneyline') { type = 'ml'; period = periodFrom(m.groupItemTitle || m.question); }
    else if (t === 'map_handicap') { type = 'hcp'; period = 'result'; }
    else if (t === 'totals') { type = 'total'; period = 'result'; }
    else if (/^round_handicap_game_(\d+)$/.test(t)) { type = 'hcp'; period = 'p' + t.match(/(\d+)$/)[1]; }
    else if (/^round_over_under_game_(\d+)$/.test(t)) { type = 'total'; period = 'p' + t.match(/(\d+)$/)[1]; }
    else continue;
    if (!period) continue;
    const outs = parseArr(m.outcomes).map(s => String(s).trim());
    const tokens = parseArr(m.clobTokenIds);
    const ask0 = num(m.bestAsk), bid0 = num(m.bestBid);
    if (outs.length !== 2 || ask0 == null) continue;
    const fee = feeOf(m);
    let legs = [
      { ask: ask0, token: tokens[0], fee },
      { ask: bid0 != null && bid0 > 0 ? r4(1 - bid0) : null, token: tokens[1], fee },
    ];
    let line = type === 'ml' ? 0 : num(m.line);
    if (type !== 'ml' && line == null) continue;
    if (type === 'total') {
      if (!/^over$/i.test(outs[0])) { if (/^over$/i.test(outs[1])) legs.reverse(); else continue; }
      line = Math.abs(line);
    } else {
      // make outcome order follow `teams`; handicap line is quoted for outcomes[0]
      const s00 = similarity(outs[0], teams[0]), s01 = similarity(outs[0], teams[1]);
      if (s01 > s00) { legs.reverse(); if (type === 'hcp') line = -line; }
    }
    markets.push({ key: marketKey(type, period, line), type, period, line, legs, question: m.question });
  }
  const full = (ev.title || '').replace(/^[^:]{2,20}:\s*/, '');
  const cut = full.indexOf(' - ');
  return {
    id: ev.id, slug: ev.slug, sport: sport.id,
    title: (cut > 0 ? full.slice(0, cut) : full) || teams.join(' vs '),
    tournament: cut > 0 ? full.slice(cut + 3) : '',
    url: `https://polymarket.com/event/${ev.slug}`, teams, start, markets,
  };
}
const r4 = x => Math.round(x * 1e4) / 1e4;

/** Align Polymarket teams with a fixture: returns { swap, score } or null. */
export function alignTeams(teams, fixture, threshold) {
  const sim = (name, variants) => Math.max(...variants.map(v => similarity(name, v)));
  const straight = [sim(teams[0], fixture.names[0]), sim(teams[1], fixture.names[1])];
  const crossed = [sim(teams[0], fixture.names[1]), sim(teams[1], fixture.names[0])];
  const a = Math.min(...straight), b = Math.min(...crossed);
  if (Math.max(a, b) < threshold) return null;
  return a >= b ? { swap: false, score: (straight[0] + straight[1]) / 2 } : { swap: true, score: (crossed[0] + crossed[1]) / 2 };
}

export function matchFixture(game, fixtures, { threshold = 0.62, timeTolerance = 6 } = {}) {
  let best = null;
  for (const f of fixtures) {
    if (game.start && f.start && Math.abs(game.start - f.start) > timeTolerance * 3600e3) continue;
    const al = alignTeams(game.teams, f, threshold);
    if (al && (!best || al.score > best.score)) best = { fixture: f, ...al };
  }
  return best;
}

/**
 * Turn an OddsPapi /v4/odds response into lines keyed like Polymarket markets,
 * already in Polymarket team order. Returns Map(key -> { quotes:[[...outcome0], [...outcome1]] }).
 */
export function oddsPapiLines(odds, marketsMap, swap, s = {}) {
  const lines = new Map();
  const whitelist = s.oddspapiBooks ? new Set(s.oddspapiBooks.split(',').map(x => x.trim()).filter(Boolean)) : null;
  for (const [book, bo] of Object.entries(odds?.bookmakerOdds || {})) {
    if (/^polymarket/i.test(book)) continue; // Polymarket comes from Gamma/CLOB directly
    if (whitelist && !whitelist.has(book)) continue;
    if (bo.suspended || bo.bookmakerIsActive === false) continue;
    const comm = EXCHANGE_KEYS.test(book) ? (s.exchangeCommission || 0) : 0;
    for (const [mid, mk] of Object.entries(bo.markets || {})) {
      const def = marketsMap[mid];
      if (!def || mk.marketActive === false || def.o.length !== 2) continue;
      const type = def.t === 'moneyline' ? 'ml' : def.t === 'spreads' ? 'hcp' : 'total';
      if (type === 'total' && !/^over$/i.test(def.o[0][1])) continue;
      const period = def.p === 'fulltime' ? 'result' : def.p;
      const prices = def.o.map(([oid]) => {
        const p = mk.outcomes?.[oid]?.players?.['0'];
        return p && p.active !== false && p.price > 1 ? p : null;
      });
      // handicap sign: OddsPapi lines are per participant 1; confirm with the book's own label when it has one
      let line = type === 'ml' ? 0 : +def.h;
      if (type === 'hcp') line = hcpForParticipant1(def.h, prices[0]?.bookmakerOutcomeId);
      if (type === 'hcp' && swap) line = -line;
      const order = type !== 'total' && swap ? [1, 0] : [0, 1];
      const key = marketKey(type, period, line);
      let entry = lines.get(key);
      if (!entry) lines.set(key, entry = { quotes: [[], []] });
      order.forEach((src, i) => {
        const p = prices[src];
        if (!p) return;
        entry.quotes[i].push({
          src: 'book', book: prettyBook(book), bookKey: book, price: p.price, q: bookCost(p.price, comm),
          limit: num(p.limit), updated: p.bookmakerChangedAt || p.changedAt, url: bo.fixturePath || null,
        });
      });
    }
  }
  return lines;
}

/** If the book labels outcome 1 with a signed number (e.g. "home/-1.5"), trust it over the market default. */
export function hcpForParticipant1(h, bookLabel) {
  const m = String(bookLabel || '').match(/([+-]?\d+(?:\.\d+)?)/);
  if (m && Math.abs(Math.abs(+m[1]) - Math.abs(h)) < 1e-9 && +m[1] !== 0) return +m[1];
  return +h;
}

const BOOK_NAMES = { pinnacle: 'Pinnacle', bet365: 'Bet365', '1xbet': '1xBet', ggbet: 'GG.bet', thunderpick: 'Thunderpick', stake: 'Stake', bcgame: 'BC.Game', vbet: 'VBET', betway: 'Betway', 'betfair-ex': 'Betfair Ex' };
const prettyBook = slug => BOOK_NAMES[slug] || slug.replace(/[-_.]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

export function periodLabel(p) {
  if (p === 'result') return 'матч';
  const n = String(p).match(/^p(\d+)$/);
  return n ? `${n[1]} карта` : p;
}
const signed = x => (x > 0 ? '+' : '') + x;
export function outcomeLabel(type, line, i) {
  if (type === 'ml') return `П${i + 1}`;
  if (type === 'hcp') return `Ф${i + 1}(${signed(i === 0 ? line : -line)})`;
  return i === 0 ? `ТБ(${line})` : `ТМ(${line})`;
}

/** A bookmaker price older than maxAgeMin minutes is skipped (0 = keep everything). */
export function isStale(updated, maxAgeMin, now = Date.now()) {
  if (!maxAgeMin || !updated) return false;
  const t = new Date(updated).getTime();
  return isFinite(t) && now - t > maxAgeMin * 60e3;
}

/** Compare one Polymarket game with one OddsPapi fixture's odds. */
export function esportsArbs(game, lines, s) {
  const out = [], compared = [];
  for (const m of game.markets) {
    const line = lines.get(m.key);
    if (!line) continue;
    const quotes = [];
    m.legs.forEach((l, i) => {
      if (l.ask > 0 && l.ask < 1) quotes.push({
        set: [i], src: 'poly', book: 'Polymarket', bookKey: 'polymarket', side: 'YES', price: l.ask, token: l.token, fee: l.fee,
        q: polyCost(l.ask, s.polyFee, l.fee), url: game.url,
      });
      for (const b of line.quotes[i]) {
        if (b.price < (s.minOdds || 1) || b.price > (s.maxOdds || 1e9)) continue;
        if (isStale(b.updated, s.maxQuoteAgeMin)) continue;
        quotes.push({ ...b, set: [i], side: 'BACK' });
      }
    });
    for (const q of quotes) {
      q.label = `${outcomeLabel(m.type, m.line, q.set[0])} (${periodLabel(m.period)})`;
      q.team = m.type === 'total' ? '' : game.teams[q.set[0]];
    }
    const best = findArbs(2, quotes, { includeBookOnly: s.includeBookOnly, minProfit: -Infinity })[0];
    if (best) compared.push({ market: m, best });
    for (const a of findArbs(2, quotes, { includeBookOnly: s.includeBookOnly, minProfit: s.minProfit })) {
      out.push({ ...a, market: m, marketLabel: `${m.type}|${periodLabel(m.period)}` });
    }
  }
  return { arbs: out, compared };
}

/**
 * Every line of a match (bookmaker lines from OddsPapi plus Polymarket markets) as
 * { key, type, period, line, quotes:[[outcome0...], [outcome1...]] } with labels — input for value bets and middles.
 */
export function lineEntries(game, lines, s = {}) {
  const map = new Map();
  const entry = key => {
    if (!map.has(key)) {
      const [type, period, line] = key.split('|');
      map.set(key, { key, type, period, line: +line, quotes: [[], []] });
    }
    return map.get(key);
  };
  for (const [key, l] of lines) {
    const e = entry(key);
    l.quotes.forEach((list, i) => list.forEach(b => {
      if (b.price < (s.minOdds || 1) || b.price > (s.maxOdds || 1e9) || isStale(b.updated, s.maxQuoteAgeMin)) return;
      e.quotes[i].push({ ...b, set: [i], side: 'BACK' });
    }));
  }
  for (const m of game.markets) {
    const e = entry(m.key);
    m.legs.forEach((l, i) => {
      if (l.ask > 0 && l.ask < 1) e.quotes[i].push({
        set: [i], src: 'poly', book: 'Polymarket', bookKey: 'polymarket', side: 'YES', price: l.ask, token: l.token, fee: l.fee,
        q: polyCost(l.ask, s.polyFee, l.fee), url: game.url,
      });
    });
  }
  for (const e of map.values()) e.quotes.forEach((list, i) => list.forEach(q => {
    q.label = `${outcomeLabel(e.type, e.line, i)} (${periodLabel(e.period)})`;
    q.team = e.type === 'total' ? '' : game.teams[i];
  }));
  return [...map.values()];
}
