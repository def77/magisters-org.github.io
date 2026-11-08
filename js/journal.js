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
      const won = e.status !== 'void' && +e.status === i;
      const net = e.status === 'void' ? 0 : (won ? l.stake * l.price - l.stake : -l.stake);
      const b = byBook.get(l.book) || { net: 0, turnover: 0 };
      b.net += net; b.turnover += +l.stake || 0;
      byBook.set(l.book, b);
    });
  }
  return { entries: inRange, turnover, profit, roi: turnover ? profit / turnover * 100 : 0, byDay, byBook };
}

export function toCSV(list) {
  const rows = [['date', 'event', 'sport', 'leg', 'book', 'bet', 'odds', 'stake', 'status', 'pnl']];
  for (const e of list) {
    const { pnl } = entryPnl(e);
    e.legs.forEach((l, i) => rows.push([new Date(e.ts).toISOString(), e.event, e.sport, i + 1, l.book, l.label, l.price, l.stake, e.status, i === 0 ? pnl.toFixed(2) : '']));
  }
  return rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}
