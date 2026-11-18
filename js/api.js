// Network: Polymarket (Gamma + CLOB, free) and DuelAPI (paid in credits).
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const DUEL = 'https://api.duelapi.com';

async function getJSON(url, init) {
  const res = await fetch(url, init);
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) {
    const e = new Error(`${new URL(url).host} ${res.status}: ${body?.message || body?.error || res.statusText}`);
    e.status = res.status; e.body = body; e.retryAfter = +res.headers.get('retry-after') || null;
    throw e;
  }
  return body;
}

/* ------------------------------- Polymarket ------------------------------- */

/** Open Gamma events of one series that have not ended yet. */
export async function polyEvents(seriesId) {
  const min = new Date(Date.now() - 3600e3).toISOString().slice(0, 19) + 'Z';
  const out = [];
  for (let offset = 0; offset < 1000; offset += 50) {
    const list = await getJSON(`${GAMMA}/events?series_id=${seriesId}&closed=false&end_date_min=${min}&limit=50&offset=${offset}`);
    const arr = Array.isArray(list) ? list : list?.data || [];
    out.push(...arr);
    if (arr.length < 50) break;
  }
  return out;
}

/** CLOB order books: Map(token -> { asks, bids }). */
export async function polyBooks(tokens) {
  const map = new Map();
  const uniq = [...new Set(tokens.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    const data = await getJSON(`${CLOB}/books`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk.map(t => ({ token_id: t }))),
    });
    for (const b of data || []) map.set(b.asset_id, { asks: b.asks || [], bids: b.bids || [] });
  }
  return map;
}

/* --------------------------------- DuelAPI -------------------------------- */
// Costs (docs): /v4/sports 2, /v4/sports/{s}/events 5, /v4/events/{id} 10, /v4/sports/{s}/odds 5 per event of `limit`.
// The key goes in the query string: a custom header would need a CORS preflight.

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class DuelApi {
  constructor(key, { log } = {}) { this.key = key; this.log = log || (() => {}); this.spent = 0; }

  async get(path, params = {}, cost = 0) {
    const qs = new URLSearchParams({ ...params, apiKey: this.key });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const body = await getJSON(`${DUEL}${path}?${qs}`);
        this.spent += cost;
        return body;
      } catch (e) {
        if (e.status === 429 && attempt < 2) {
          const wait = (e.retryAfter || 7) * 1000;
          this.log(`DuelAPI: лимит запросов в минуту, жду ${Math.round(wait / 1000)} с`, 'warn');
          await sleep(wait);
          continue;
        }
        if (e.status === 402) e.message = `DuelAPI: кончились кредиты (${e.body?.message || ''})`;
        if (e.status === 401 || e.status === 403) e.message = 'DuelAPI: ключ не подходит';
        throw e;
      }
    }
  }

  account() { return this.get('/account'); }

  /** Sport keys by title, cached for 12 hours (2 credits per refresh). */
  async sports() {
    const k = 'duel.sports.v1';
    try { const c = JSON.parse(localStorage.getItem(k) || 'null'); if (c && Date.now() - c.t < 12 * 3600e3) return c.d; } catch {}
    const d = await this.get('/v4/sports', {}, 2);
    try { localStorage.setItem(k, JSON.stringify({ t: Date.now(), d })); } catch {}
    return d;
  }

  events(sport) { return this.get(`/v4/sports/${sport}/events`, { live: 0 }, 5); }
  event(id) { return this.get(`/v4/events/${id}`, {}, 10); }
  odds(sport, limit, offset = 0) { return this.get(`/v4/sports/${sport}/odds`, { live: 0, limit, offset }, 5 * limit); }

  /**
   * Odds for the wanted events, as cheaply as possible:
   * one bulk call over the first N upcoming events (5 each) or one call per event (10 each).
   */
  async oddsFor(sport, wantedIds, eventOrder) {
    const want = new Set(wantedIds);
    if (!want.size) return [];
    const lastPos = Math.max(...eventOrder.map((id, i) => (want.has(id) ? i : -1)));
    const bulkCost = 5 * (lastPos + 1), singleCost = 10 * want.size;
    const got = new Map();
    if (lastPos >= 0 && bulkCost < singleCost && lastPos < 100) {
      const list = await this.odds(sport, lastPos + 1);
      for (const e of list || []) if (want.has(String(e.id))) got.set(String(e.id), e);
    }
    for (const id of want) {
      if (got.has(id)) continue;
      const e = await this.event(id);
      got.set(id, Array.isArray(e) ? e[0] : e);
    }
    return [...got.values()];
  }
}
