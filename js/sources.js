// Data sources: Polymarket (Gamma + CLOB) and bookmakers (The Odds API).

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const ODDS = 'https://api.the-odds-api.com/v4';

export function withProxy(url, proxy) {
  if (!proxy) return url;
  return proxy.includes('{url}') ? proxy.replace('{url}', encodeURIComponent(url)) : proxy + url;
}

async function getJSON(url, proxy, init) {
  const res = await fetch(withProxy(url, proxy), init);
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 200); } catch {}
    throw new Error(`HTTP ${res.status} ${url.split('?')[0]} ${body}`);
  }
  return { data: await res.json(), headers: res.headers };
}

const parseArr = v => {
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v || '[]'); } catch { return []; }
};

export function parseDate(s) {
  if (!s) return null;
  let t = String(s).trim().replace(' ', 'T');
  if (/[+-]\d\d$/.test(t)) t += ':00';
  const d = new Date(t);
  return isNaN(d) ? null : d;
}

const BAD_Q = /\b(spread|o\/u|over|under|totals?|handicap|half|1h|2h|quarter|period|by \d|exact|score|both teams|corners|cards|first|points|rebounds|assists|yards|map \d|set \d|game \d)\b/i;
const YESNO = o => o.length === 2 && /^yes$/i.test(o[0]) && /^no$/i.test(o[1]);
// sportsMarketType is authoritative when Gamma provides it; the question regex is only a fallback.
const isMoneyline = m => (m.sportsMarketType ? m.sportsMarketType === 'moneyline' : !BAD_Q.test(m.question || ''));
const feeOf = m => (m.feesEnabled && m.feeSchedule ? { rate: +m.feeSchedule.rate || 0, exponent: +m.feeSchedule.exponent || 1 } : null);

/** Convert a Gamma event into our unified Polymarket game, or null if it isn't a single game. */
export function parsePolyEvent(ev, sport) {
  const markets = (ev.markets || []).filter(m => m.active !== false && !m.closed && m.acceptingOrders !== false);
  if (!markets.length) return null;
  const title = ev.title || '';
  const dateHint = (ev.slug || '').match(/\d{4}-\d{2}-\d{2}/)?.[0] || null;
  const start = parseDate(ev.startTime) || parseDate(markets[0].gameStartTime) || parseDate(markets[0].eventStartTime);
  const base = {
    id: ev.id, slug: ev.slug, title, sport: sport.id, start, dateHint,
    url: `https://polymarket.com/event/${ev.slug}`,
    volume: +ev.volume || 0, liquidity: +ev.liquidity || 0,
  };

  // 1) Moneyline with team outcomes: outcomes ["Lakers","Celtics"]
  const ml = markets.find(m => {
    const o = parseArr(m.outcomes);
    if (o.length !== 2 || YESNO(o)) return false;
    return isMoneyline(m) && !/^(over|under)$/i.test(o[0]);
  });
  if (ml && sport.outcomes === 2) {
    const names = parseArr(ml.outcomes);
    const tokens = parseArr(ml.clobTokenIds);
    const prices = parseArr(ml.outcomePrices).map(Number);
    const ask0 = num(ml.bestAsk) ?? prices[0];
    const bid0 = num(ml.bestBid);
    const ask1 = bid0 != null && bid0 > 0 ? 1 - bid0 : prices[1];
    return {
      ...base, kind: 'moneyline',
      outcomes: [
        { name: names[0], yes: leg(ask0, tokens[0], ml, bid0), no: null },
        { name: names[1], yes: leg(ask1, tokens[1], ml, ask0 != null ? 1 - ask0 : null), no: null },
      ],
    };
  }

  // 2) Yes/No markets per outcome: "Will Arsenal win?", "Draw?", "Will Chelsea win?"
  const yn = markets.filter(m => {
    if (!YESNO(parseArr(m.outcomes))) return false;
    const q = (m.question || '') + ' ' + (m.groupItemTitle || '');
    return isMoneyline(m) && /win|draw|tie/i.test(q);
  });
  if (yn.length === sport.outcomes) {
    const outs = yn.map(m => {
      const tokens = parseArr(m.clobTokenIds);
      const prices = parseArr(m.outcomePrices).map(Number);
      const ask = num(m.bestAsk) ?? prices[0];
      const bid = num(m.bestBid);
      const noAsk = bid != null && bid > 0 ? 1 - bid : prices[1];
      let name = m.groupItemTitle || (m.question || '').replace(/^will\s+/i, '').replace(/\s+win.*$/i, '');
      if (/draw|tie/i.test(m.question || '') && !m.groupItemTitle) name = 'Draw';
      if (/^draw|^tie/i.test(name)) name = 'Draw';
      return { name, yes: leg(ask, tokens[0], m, bid), no: leg(noAsk, tokens[1], m, ask != null ? 1 - ask : null) };
    });
    if (sport.outcomes === 3 && !outs.some(o => o.name === 'Draw')) return null;
    return { ...base, kind: sport.outcomes === 3 ? '1x2' : 'moneyline', outcomes: outs };
  }
  return null;
}

const num = v => (v === undefined || v === null || v === '' || isNaN(+v) ? null : +v);
const r4 = x => (x == null ? null : Math.round(x * 1e4) / 1e4);
// bid = best price someone pays for this outcome now (for limit orders); tick = price step
const leg = (ask, token, m, bid = null) => ({ ask: r4(num(ask)), bid: r4(num(bid)), tick: num(m.orderPriceMinTickSize) || 0.01, token, marketId: m.id, minSize: num(m.orderMinSize), fee: feeOf(m) });

/** Raw Gamma events for one Polymarket series that have not finished yet. */
export async function fetchGammaEvents(sport, proxy, hoursAhead = 48) {
  const now = Date.now();
  const min = new Date(now - 3 * 3600e3).toISOString().slice(0, 19) + 'Z';
  const out = [];
  for (let offset = 0; offset < 1000; offset += 200) {
    const url = `${GAMMA}/events?series_id=${sport.series}&closed=false&end_date_min=${min}&limit=200&offset=${offset}`;
    const { data } = await getJSON(url, proxy);
    const list = Array.isArray(data) ? data : (data.data || data.events || []);
    out.push(...list);
    if (list.length < 200) break;
  }
  const horizon = now + hoursAhead * 3600e3;
  return out.filter(ev => {
    const t = parseDate(ev.startTime) || parseDate(ev.markets?.[0]?.gameStartTime);
    return !t || t.getTime() <= horizon;
  });
}

export async function fetchPolymarket(sport, proxy, log, hoursAhead) {
  const events = await fetchGammaEvents(sport, proxy, hoursAhead);
  const out = events.map(ev => parsePolyEvent(ev, sport)).filter(Boolean);
  log?.(`Polymarket ${sport.label}: ${out.length} матчей`);
  return out;
}

/** Order books for many tokens at once. Returns Map(token -> asks[]) */
export async function fetchBooks(tokens, proxy) {
  const map = new Map();
  const uniq = [...new Set(tokens.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    const { data } = await getJSON(`${CLOB}/books`, proxy, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk.map(t => ({ token_id: t }))),
    });
    for (const b of data || []) map.set(b.asset_id, b.asks || []);
  }
  return map;
}

export async function fetchOdds(sport, s, log) {
  const params = new URLSearchParams({
    apiKey: s.oddsApiKey, markets: 'h2h', oddsFormat: 'decimal', dateFormat: 'iso',
  });
  if (s.bookmakers.trim()) params.set('bookmakers', s.bookmakers.replace(/\s+/g, ''));
  else params.set('regions', s.regions.replace(/\s+/g, '') || 'eu');
  const { data, headers } = await getJSON(`${ODDS}/sports/${sport.odds}/odds?${params}`, s.corsProxy);
  const remaining = headers.get('x-requests-remaining');
  const events = (data || []).map(parseOddsEvent);
  log?.(`Букмекеры ${sport.label}: ${events.length} матчей` + (remaining ? ` · кредитов осталось: ${remaining}` : ''));
  return { events, remaining };
}

export function parseOddsEvent(e) {
  const books = [];
  const names = new Set();
  for (const b of e.bookmakers || []) {
    const m = (b.markets || []).find(x => x.key === 'h2h');
    if (!m) continue;
    const prices = {};
    for (const o of m.outcomes) { prices[o.name] = +o.price; names.add(o.name); }
    books.push({ key: b.key, title: b.title, prices, updated: m.last_update || b.last_update });
  }
  return {
    id: e.id, sport: e.sport_key, start: parseDate(e.commence_time),
    home: e.home_team, away: e.away_team, title: `${e.home_team} vs ${e.away_team}`,
    outcomeNames: [...names], books,
  };
}

export async function sendTelegram(token, chat, text) {
  // form-encoded "simple" request works even without CORS (opaque response)
  const body = new URLSearchParams({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: 'true' });
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', mode: 'no-cors', body });
}
