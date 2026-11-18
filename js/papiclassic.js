// Classic sports (football, NBA, ...) through OddsPapi: match result / 1X2 from every book on the plan,
// crypto books included (Stake, BC.Game, ...). The Odds API does not carry those books.
// Output uses the same shape as parseOddsEvent, so the classic scanner works unchanged.
import { alignOutcomes } from './match.js';
import { prettyBook } from './esports.js';

// Crypto bookmakers / casinos with a sportsbook. Matched against OddsPapi slugs and names.
export const CRYPTO_BOOKS = /(^|[^a-z])(stake|duel|bc\.?game|roobet|rollbit|cloudbet|thunderpick|sportsbet\.?io|betfury|shuffle|gamdom|bitsler|betplay|fairspin|mystake|jackbit|coinplay|vave|metaspins|winz|bitcasino|bets\.?io|betpanda|lucky\.?block|crypto|bitstarz|empire\.?io|7bit|wild\.?io|nitrobetting|betcoin|nitrogen|1xbit)([^a-z]|$)/i;
export const isCryptoBook = keyOrName => CRYPTO_BOOKS.test(String(keyOrName || '').replace(/[_-]/g, ' '));

/** OddsPapi bookmakers list -> slugs of crypto books. */
export function cryptoSlugs(books) {
  return (books || []).filter(b => isCryptoBook(b.slug) || isCryptoBook(b.name || b.bookmakerName)).map(b => b.slug);
}

const isDraw = name => /^(x|draw|tie)$/i.test(String(name || '').trim());

/**
 * Full-time match result from one OddsPapi /odds response.
 * n = 2 (moneyline) or 3 (1X2). Returns books in parseOddsEvent form with prices keyed
 * by names[] = [participant1, participant2] (+ 'Draw' for 1X2).
 */
export function papiResultBooks(odds, marketsMap, n, names, s = {}) {
  const whitelist = s.oddspapiBooks ? new Set(s.oddspapiBooks.split(',').map(x => x.trim()).filter(Boolean)) : null;
  const books = [];
  for (const [book, bo] of Object.entries(odds?.bookmakerOdds || {})) {
    if (/^polymarket/i.test(book)) continue;
    if (whitelist && !whitelist.has(book)) continue;
    if (bo.suspended || bo.bookmakerIsActive === false) continue;
    for (const [mid, mk] of Object.entries(bo.markets || {})) {
      const def = marketsMap[mid];
      if (!def || (def.t !== 'moneyline' && def.t !== '1x2') || mk.marketActive === false) continue;
      if (def.p && def.p !== 'fulltime' && def.p !== 'result') continue;
      if (def.o.length !== n) continue;
      // OddsPapi order: participant1, (draw), participant2
      const found = def.o.findIndex(([, nm]) => isDraw(nm));
      const drawIdx = n === 3 ? (found >= 0 ? found : 1) : -1;
      const others = def.o.map((_, i) => i).filter(i => i !== drawIdx);
      const prices = {}, limits = {};
      let updated = null, ok = true;
      def.o.forEach(([oid], i) => {
        const p = mk.outcomes?.[oid]?.players?.['0'];
        if (!p || p.active === false || !(p.price > 1)) { ok = false; return; }
        const name = i === drawIdx ? 'Draw' : names[others.indexOf(i)];
        prices[name] = +p.price;
        if (p.limit != null && !isNaN(+p.limit)) limits[name] = +p.limit;
        const t = p.bookmakerChangedAt || p.changedAt;
        if (t && (!updated || t > updated)) updated = t;
      });
      if (!ok) continue;
      books.push({ key: book, title: prettyBook(book), prices, limits, updated, url: bo.fixturePath || null, papi: true });
      break; // one full-time result market per book
    }
  }
  return books;
}

/** OddsPapi fixture + its books -> event in parseOddsEvent form. */
export function papiEvent(fixture, books, n) {
  const [home, away] = [fixture.names[0][0], fixture.names[1][0]];
  return {
    id: 'papi:' + fixture.id, sport: 'papi', start: fixture.start, home, away,
    title: `${home} vs ${away}`, outcomeNames: n === 3 ? [home, 'Draw', away] : [home, away], books,
  };
}

/**
 * Put OddsPapi books into the event pool: if The Odds API already has this match, its books are
 * added there (prices renamed to that event's outcome names, books it already has are skipped);
 * otherwise the OddsPapi event joins the pool as it is.
 */
export function mergePapiEvent(pool, ev, { threshold = 0.62, timeTolerance = 6 } = {}) {
  let best = null;
  for (const o of pool) {
    if (o.start && ev.start && Math.abs(o.start - ev.start) > timeTolerance * 3600e3) continue;
    const al = alignOutcomes(ev.outcomeNames, o.outcomeNames, threshold);
    if (al && (!best || al.score > best.score)) best = { o, al };
  }
  if (!best) { pool.push(ev); return 'added'; }
  const have = new Set(best.o.books.map(b => b.key));
  const rename = Object.fromEntries(ev.outcomeNames.map((nm, i) => [nm, best.al.names[i]]));
  for (const b of ev.books) {
    if (have.has(b.key)) continue;
    const re = obj => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [rename[k] ?? k, v]));
    best.o.books.push({ ...b, prices: re(b.prices), limits: re(b.limits) });
  }
  return 'merged';
}
