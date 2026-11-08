// OddsPapi v4 client (https://oddspapi.io/us/docs). Key goes in the apiKey query parameter.
// Every call to a billable endpoint costs 1 request of the monthly quota, so metadata is cached.
import { withProxy, parseDate } from './sources.js';

const BASE = 'https://api.oddspapi.io/v4';
const COOLDOWN = { fixtures: 2000, odds: 500, markets: 1000, bookmakers: 1000, account: 1000 };
const last = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const cache = {
  get(k, maxAgeMs) {
    try {
      const v = JSON.parse(localStorage.getItem(k) || 'null');
      return v && Date.now() - v.t < maxAgeMs ? v.d : null;
    } catch { return null; }
  },
  set(k, d) { try { localStorage.setItem(k, JSON.stringify({ t: Date.now(), d })); } catch {} },
};

export class OddsPapi {
  constructor(key, { proxy = '', log } = {}) {
    this.key = key; this.proxy = proxy; this.log = log; this.used = 0;
  }

  async get(path, params = {}) {
    const ep = path.split('/')[0];
    const wait = (last[ep] || 0) + (COOLDOWN[ep] || 1000) - Date.now();
    if (wait > 0) await sleep(wait);
    const qs = new URLSearchParams({ ...params, apiKey: this.key });
    for (let attempt = 0; attempt < 3; attempt++) {
      last[ep] = Date.now();
      const res = await fetch(withProxy(`${BASE}/${path}?${qs}`, this.proxy));
      if (ep !== 'account') this.used++;
      let body = null;
      try { body = await res.json(); } catch {}
      if (res.ok) return body;
      const err = body?.error || {};
      if (res.status === 429 && err.code === 'RATE_LIMITED') { await sleep((err.retryMs || 600) + 50); continue; }
      const e = new Error(`OddsPapi ${path}: ${res.status} ${err.code || ''} ${err.details || err.message || ''}`.trim());
      e.code = err.code; e.status = res.status;
      throw e;
    }
    throw new Error(`OddsPapi ${path}: rate limited`);
  }

  account() { return this.get('account'); }

  async bookmakers() {
    const k = 'polyarb.papi.bookmakers';
    let d = cache.get(k, 24 * 3600e3);
    if (!d) { d = await this.get('bookmakers'); cache.set(k, d); }
    return d;
  }

  /** marketId -> { type, period, handicap, outcomes:[{id,name}] } for the given sports. Cached 24h. */
  async markets(sportIds) {
    const k = 'polyarb.papi.markets.v1';
    let d = cache.get(k, 24 * 3600e3);
    if (!d || sportIds.some(id => !d.sports.includes(id))) {
      const all = await this.get('markets');
      const keep = new Set(sportIds);
      const map = {};
      for (const m of all || []) {
        if (!keep.has(m.sportId) || m.playerProp) continue;
        if (!['moneyline', 'spreads', 'totals'].includes(m.marketType)) continue;
        map[m.marketId] = { t: m.marketType, p: m.period, h: m.handicap, o: (m.outcomes || []).map(x => [x.outcomeId, x.outcomeName]) };
      }
      d = { sports: [...keep], map };
      cache.set(k, d);
    }
    return d.map;
  }

  async fixtures(sportId, hoursAhead = 48) {
    const from = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 19) + 'Z';
    const to = new Date(Date.now() + Math.min(hoursAhead, 239) * 3600e3).toISOString().slice(0, 19) + 'Z';
    const list = await this.get('fixtures', { sportId, from, to, hasOdds: 'true' });
    return (list || []).filter(f => f.statusId === 0 || f.statusId === 1).map(f => ({
      id: f.fixtureId, sportId: f.sportId, start: parseDate(f.startTime), live: f.statusId === 1,
      tournament: f.tournamentName, names: [
        [f.participant1Name, f.participant1ShortName, f.participant1Abbr].filter(Boolean),
        [f.participant2Name, f.participant2ShortName, f.participant2Abbr].filter(Boolean),
      ],
      title: `${f.participant1Name} vs ${f.participant2Name}`,
    }));
  }

  odds(fixtureId, bookmakers = '') {
    const p = { fixtureId, oddsFormat: 'decimal', verbosity: 3 };
    if (bookmakers) p.bookmakers = bookmakers.replace(/\s+/g, '');
    return this.get('odds', p);
  }
}
