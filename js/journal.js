// Bet journal: arbs and value bets you placed, settled from Polymarket's own market resolution.
// Every entry is tied to one Polymarket market (its id and the token of one side), so the result is
// read from the very market the bet was compared with — free, and no name matching after the game.
//
// entry = {
//   id, ts, kind: 'arb' | 'value', title, start, sport, label, polyUrl, duelUrl, marketId, token,
//   poly: { side, price, shares, usd } | null,        // arb only: what was bought on Polymarket
//   duel: { side, label, odds, stake },
//   tokenIsDuelSide: bool,                            // value: Duel wins when `token` wins; arb: when it loses
//   open: { fairP }, close: { odds, fairP, at } | null,
//   result: null | 'poly' | 'duel' | 'duel-void-poly-won' | 'duel-void-poly-lost' | 'void' | 'won' | 'lost' | 'half',
//   manual: bool,
// }

const LS = 'duelpoly.journal.v1';
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export function loadJournal() { try { return JSON.parse(localStorage.getItem(LS) || '[]'); } catch { return []; } }
export function saveJournal(list) { try { localStorage.setItem(LS, JSON.stringify(list)); } catch {} }

/** From an arb row (compare.js) and the stakes actually used. */
export function arbEntry(r, { shares, polyUsd, duelStake, price, odds } = {}) {
  return {
    id: uid(), ts: Date.now(), kind: 'arb', title: r.poly.title, start: +r.poly.start, sport: r.poly.sport, label: r.label,
    polyUrl: r.poly.url, duelUrl: r.duel.url, marketId: r.polyLeg.marketId, token: r.polyLeg.token, tokenIsDuelSide: false,
    polyKey: r.poly.id, marketKey: r.market.key, duelIdx: 1 - r.pi,
    poly: { side: r.pSide, price: price ?? r.polyLeg.price, shares: shares ?? r.polyShares, usd: polyUsd ?? r.polyUsd },
    duel: { side: r.dSide, label: r.duelLeg.label, odds: odds ?? r.duelLeg.price, stake: duelStake ?? r.duelStake },
    open: { fairP: null }, close: null, result: null, manual: false,
  };
}

/** From a value row (compare.js valueBets). */
export function valueEntry(v, { stake, odds } = {}) {
  return {
    id: uid(), ts: Date.now(), kind: 'value', title: v.poly.title, start: +v.poly.start, sport: v.poly.sport, label: v.label,
    polyUrl: v.poly.url, duelUrl: v.duel.url, marketId: v.market.outs[v.i].marketId, token: v.market.outs[v.i].token, tokenIsDuelSide: true,
    polyKey: v.poly.id, marketKey: v.market.key, duelIdx: v.i,
    poly: null, duel: { side: v.side, label: v.duelLeg.label, odds: odds ?? v.duelLeg.price, stake: stake ?? v.stake },
    open: { fairP: v.p }, close: null, result: null, manual: false,
  };
}

/**
 * Result from a Gamma market (GET /markets/{id}): null while it is not resolved.
 * 'half' — the market resolved 50-50 (cancelled game...): check by hand.
 */
export function resultFromMarket(e, m) {
  if (!m || !m.closed || (m.umaResolutionStatus && m.umaResolutionStatus !== 'resolved')) return null;
  const parse = v => (Array.isArray(v) ? v : JSON.parse(v || '[]'));
  const tokens = parse(m.clobTokenIds), prices = parse(m.outcomePrices).map(Number);
  const i = tokens.indexOf(e.token);
  if (i < 0 || prices[i] == null) return null;
  if (prices[i] > 0.99) return e.kind === 'arb' ? 'poly' : 'won';
  if (prices[i] < 0.01) return e.kind === 'arb' ? 'duel' : 'lost';
  return 'half';
}

/** Profit of one entry; null while open or 'half'. */
export function entryPnl(e) {
  const r = e.result;
  if (!r || r === 'half') return null;
  if (e.kind === 'value') {
    if (r === 'won') return e.duel.stake * (e.duel.odds - 1);
    if (r === 'lost') return -e.duel.stake;
    return 0; // void
  }
  const total = e.poly.usd + e.duel.stake;
  switch (r) {
    case 'poly': return e.poly.shares - total;
    case 'duel': return e.duel.stake * e.duel.odds - total;
    case 'duel-void-poly-won': return e.poly.shares - e.poly.usd;   // Duel refunded the stake
    case 'duel-void-poly-lost': return -e.poly.usd;
    case 'void': return 0;
    default: return null;
  }
}
export const entryTurnover = e => (e.poly ? e.poly.usd : 0) + e.duel.stake;

/**
 * Closing line value: how much better the price taken was than the fair line at the start
 * (Polymarket's fair probability of the Duel side). +5% = the bet was worth 5% more than at close.
 */
export function entryClv(e) {
  const p = e.close?.fairP;
  if (!(p > 0 && p < 1)) return null;
  return (e.duel.odds * p - 1) * 100;
}

export function journalStats(list) {
  const part = kind => {
    const items = list.filter(e => e.kind === kind);
    const settled = items.filter(e => entryPnl(e) != null);
    const pnl = settled.reduce((a, e) => a + entryPnl(e), 0);
    const turnover = settled.reduce((a, e) => a + entryTurnover(e), 0);
    const clv = items.map(entryClv).filter(x => x != null);
    return {
      count: items.length, open: items.length - settled.length, settled: settled.length, pnl, turnover,
      roi: turnover ? pnl / turnover * 100 : null, clv: clv.length ? clv.reduce((a, b) => a + b, 0) / clv.length : null,
    };
  };
  return { arb: part('arb'), value: part('value') };
}

const RESULT_RU = {
  poly: 'выиграл Polymarket', duel: 'выиграл Duel', 'duel-void-poly-won': 'Duel вернул, Polymarket выиграл',
  'duel-void-poly-lost': 'Duel вернул, Polymarket проиграл', void: 'всё вернули', won: 'выигрыш', lost: 'проигрыш', half: 'Polymarket 50/50 — проверьте',
};
export const resultLabel = r => (r ? RESULT_RU[r] || r : 'ожидает');

export function toCSV(list) {
  const head = ['дата', 'тип', 'матч', 'начало', 'рынок', 'Polymarket сторона', 'Polymarket цена', 'акций', 'Polymarket $', 'Duel сторона', 'Duel кэф', 'Duel ставка', 'результат', 'прибыль', 'CLV %'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = list.map(e => [
    new Date(e.ts).toISOString(), e.kind === 'arb' ? 'вилка' : 'валуйка', e.title, new Date(e.start).toISOString(), e.label,
    e.poly?.side, e.poly?.price, e.poly?.shares?.toFixed(2), e.poly?.usd?.toFixed(2), e.duel.label, e.duel.odds, e.duel.stake.toFixed(2),
    resultLabel(e.result), entryPnl(e)?.toFixed(2), entryClv(e)?.toFixed(2),
  ].map(q).join(','));
  return [head.map(q).join(','), ...rows].join('\n');
}
