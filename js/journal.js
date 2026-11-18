// Bet journal: stored in the browser, with P/L by day and by bookmaker.
const KEY = 'polyarb.journal.v1';

export function loadJournal() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
export function saveJournal(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {}
}

/**
 * entry: { id, ts, event, sport, legs:[{book, label, price, stake}], status: 'pending'|'void'|<winning leg index> }
 * P/L: winning leg pays stake*price, everything else is lost. 'void' returns all stakes.
 */
export function entryPnl(e) {
  const total = e.legs.reduce((a, l) => a + (+l.stake || 0), 0);
  if (e.status === 'pending' || e.status === 'void' || e.status == null) return { total, pnl: 0, settled: e.status === 'void' };
  if (e.status === 'lost') return { total, pnl: -total, settled: true };
  if (Array.isArray(e.status)) { // several legs won (middles, cross-market arbs)
    return { total, pnl: e.status.reduce((a, i) => a + (e.legs[i] ? e.legs[i].stake * e.legs[i].price : 0), 0) - total, settled: true };
  }
  const w = e.legs[+e.status];
  return { total, pnl: w ? w.stake * w.price - total : 0, settled: true };
}
export const expectedPnl = e => {
  const total = e.legs.reduce((a, l) => a + (+l.stake || 0), 0);
  return Math.min(...e.legs.map(l => l.stake * l.price)) - total;
};

export function journalStats(list, from, to) {
  const inRange = list.filter(e => (!from || e.ts >= from) && (!to || e.ts <= to));
  let turnover = 0, profit = 0;
  const byDay = new Map(), byBook = new Map();
  for (const e of inRange) {
    const { total, pnl, settled } = entryPnl(e);
    turnover += total;
    if (!settled) continue;
    profit += pnl;
    const day = new Date(e.ts).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + pnl);
    // per-book net: each leg's own result
    e.legs.forEach((l, i) => {
      const won = e.status !== 'void' && e.status !== 'lost' && (Array.isArray(e.status) ? e.status.includes(i) : +e.status === i);
      const net = e.status === 'void' ? 0 : (won ? l.stake * l.price - l.stake : -l.stake);
      const b = byBook.get(l.book) || { net: 0, turnover: 0 };
      b.net += net; b.turnover += +l.stake || 0;
      byBook.set(l.book, b);
    });
  }
  // CLV: stake-weighted, over legs that have a closing line
  let clvW = 0, clvS = 0;
  for (const e of inRange) for (const l of e.legs) {
    const c = legClv(l);
    if (c != null) { clvW += c * l.stake; clvS += l.stake; }
  }
  return { entries: inRange, turnover, profit, roi: turnover ? profit / turnover * 100 : 0, byDay, byBook, clv: clvS ? clvW / clvS : null };
}

/** CLV of one leg, %: odds taken vs fair closing odds of the sharp book. */
export const legClv = l => (l.closeFair > 1 && l.price > 1 ? (l.price / l.closeFair - 1) * 100 : null);

/**
 * Closing fair odds from an OddsPapi historical-odds response for one bookmaker:
 * last price at or before the start for every outcome of the market, margin removed.
 */
export function closingFair(hist, book, mid, oid, startMs) {
  const market = hist?.bookmakers?.[book]?.markets?.[mid];
  if (!market) return null;
  const last = {};
  for (const [id, o] of Object.entries(market.outcomes || {})) {
    const series = o.players?.['0'] || Object.values(o.players || {})[0] || [];
    const before = series.filter(x => x.price > 1 && new Date(x.createdAt).getTime() <= startMs)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (before[0]) last[id] = before[0].price;
  }
  const ids = Object.keys(last);
  if (!(String(oid) in last) || ids.length < 2) return null;
  const sum = ids.reduce((a, id) => a + 1 / last[id], 0);
  return 1 / ((1 / last[oid]) / sum);
}

export function toCSV(list) {
  const rows = [['date', 'event', 'sport', 'leg', 'book', 'bet', 'odds', 'stake', 'status', 'pnl', 'close_fair', 'clv_pct']];
  for (const e of list) {
    const { pnl } = entryPnl(e);
    e.legs.forEach((l, i) => rows.push([new Date(e.ts).toISOString(), e.event, e.sport, i + 1, l.book, l.label, l.price, l.stake, e.status, i === 0 ? pnl.toFixed(2) : '', l.closeFair ? l.closeFair.toFixed(3) : '', legClv(l)?.toFixed(2) ?? '']));
  }
  return rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}
