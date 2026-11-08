// OddsPapi v4 client (https://oddspapi.io/us/docs). Key goes in the apiKey query parameter.
// Every call to a billable endpoint costs 1 request of the monthly quota, so metadata is cached.
import { withProxy, parseDate } from './sources.js';

const BASE = 'https://api.oddspapi.io/v4';
// Responses are documented as bare arrays/objects; tolerate a { data } wrapper too.
const unwrap = d => (Array.isArray(d) ? d : d && typeof d === 'object' && 'data' in d ? d.data : d);
const COOLDOWN = { fixtures: 2000, odds: 500, markets: 1000, bookmakers: 1000, account: 1000, 'historical-odds': 5000 };
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
      if (ep !== 'account' && ep !== 'historical-odds') this.used++; // both are free
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

  /** Price history of up to 3 bookmakers for one fixture (free endpoint, 5 s cooldown). */
  async historical(fixtureId, bookmakers = 'pinnacle') {
    return unwrap(await this.get('historical-odds', { fixtureId, bookmakers }));
  }

  async bookmakers() {
    const k = 'polyarb.papi.bookmakers';
    let d = cache.get(k, 24 * 3600e3);
    if (!d) { d = unwrap(await this.get('bookmakers')) || []; cache.set(k, d); }
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
      for (const m of unwrap(all) || []) {
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
    const list = unwrap(await this.get('fixtures', { sportId, from, to, hasOdds: 'true' }));
    return (Array.isArray(list) ? list : []).filter(f => f.statusId === 0 || f.statusId === 1).map(f => ({
      id: f.fixtureId, sportId: f.sportId, start: parseDate(f.startTime), live: f.statusId === 1,
      tournament: f.tournamentName, names: [
        [f.participant1Name, f.participant1ShortName, f.participant1Abbr].filter(Boolean),
        [f.participant2Name, f.participant2ShortName, f.participant2Abbr].filter(Boolean),
      ],
      title: `${f.participant1Name} vs ${f.participant2Name}`,
    }));
  }

  async odds(fixtureId, bookmakers = '') {
    const p = { fixtureId, oddsFormat: 'decimal', verbosity: 3 };
    if (bookmakers) p.bookmakers = bookmakers.replace(/\s+/g, '');
    const r = unwrap(await this.get('odds', p));
    return Array.isArray(r) ? r[0] : r;
  }

  /**
   * Short plain-text report about the real response shapes (no key inside), for checking the parser:
   * account quota, bookmakers, one fixture and, per market type, what the books send.
   */
  async diagnose(sportId) {
    const lines = [`OddsPapi diagnose · sportId ${sportId} · ${new Date().toISOString()}`];
    const short = v => JSON.stringify(v)?.slice(0, 300);
    try { lines.push('account: ' + short(await this.account())); } catch (e) { lines.push('account ERROR ' + e.message); }
    let books = [];
    try { books = await this.bookmakers(); lines.push(`bookmakers (${books.length}): ` + books.map(b => b.slug).join(',').slice(0, 1500)); }
    catch (e) { lines.push('bookmakers ERROR ' + e.message); }
    let map = {};
    try { map = await this.markets([sportId]); lines.push(`markets for sport: ${Object.keys(map).length}`); }
    catch (e) { lines.push('markets ERROR ' + e.message); }
    let fx = [];
    try { fx = await this.fixtures(sportId, 48); lines.push(`fixtures 48h: ${fx.length}` + (fx[0] ? ` · first: ${fx[0].id} ${fx[0].title} ${fx[0].start?.toISOString()}` : '')); }
    catch (e) { lines.push('fixtures ERROR ' + e.message); }
    if (!fx.length) return lines.join('\n');
    let odds;
    try { odds = await this.odds(fx[0].id); }
    catch (e) { lines.push('odds ERROR ' + e.message); return lines.join('\n'); }
    lines.push('odds top-level keys: ' + Object.keys(odds || {}).join(','));
    const bo = odds?.bookmakerOdds || {};
    lines.push(`books in odds: ${Object.keys(bo).join(',')}`);
    const seen = new Set();
    for (const [book, b] of Object.entries(bo)) {
      lines.push(`[${book}] keys: ${Object.keys(b).join(',')} · suspended=${b.suspended} · markets=${Object.keys(b.markets || {}).length}`);
      for (const [mid, mk] of Object.entries(b.markets || {})) {
        const def = map[mid];
        const kind = def ? `${def.t}|${def.p}|${def.h}` : 'unknown';
        if (seen.has(book + kind.split('|').slice(0, 2).join('|')) && def?.t !== 'spreads') continue;
        seen.add(book + kind.split('|').slice(0, 2).join('|'));
        const outs = Object.entries(mk.outcomes || {}).map(([oid, o]) => {
          const pl = o.players?.['0'] || Object.values(o.players || {})[0] || {};
          const name = def?.o.find(x => String(x[0]) === oid)?.[1];
          return `${oid}${name ? '=' + name : ''}:${pl.price}@"${pl.bookmakerOutcomeId}"${pl.limit != null ? ' lim' + pl.limit : ''}${pl.changedAt ? ' ch ' + String(pl.changedAt).slice(11, 19) : ''}`;
        });
        lines.push(`   m${mid} ${kind} active=${mk.marketActive} · ${outs.join(' | ')}`);
        if (lines.length > 160) { lines.push('…'); return lines.join('\n'); }
      }
    }
    return lines.join('\n');
  }
}
