// Line movement during the session: when Duel changed a price, and how far Polymarket's fair line
// moved since then. "Duel lags" = Polymarket moved, Duel did not.
// Keys are Polymarket-frame market keys; side i is the same side as in compare.js.

const KEEP_MS = 3 * 3600e3;

export class LineLog {
  constructor() { this.duel = new Map(); this.fair = new Map(); }

  /** Record Duel prices of one market (already in Polymarket frame). */
  duelPrices(key, prices, now = Date.now()) {
    prices.forEach((price, i) => {
      if (!(price > 1)) return;
      const k = `${key}|${i}`;
      const h = this.duel.get(k);
      if (!h) { this.duel.set(k, [{ at: now, price, first: true }]); return; }
      if (h[h.length - 1].price !== price) h.push({ at: now, price });
      while (h.length > 2 && now - h[1].at > KEEP_MS) h.shift();
    });
  }

  /** Record Polymarket's fair probability of side 0 for a market. */
  fairP(key, p0, now = Date.now()) {
    if (!(p0 > 0 && p0 < 1)) return;
    const h = this.fair.get(key) || [];
    if (!h.length || Math.abs(h[h.length - 1].p - p0) >= 0.0005) h.push({ at: now, p: p0 });
    else h[h.length - 1].seen = now;
    while (h.length > 2 && now - h[0].at > KEEP_MS) h.shift();
    this.fair.set(key, h);
  }

  /** Duel price history of one side: [{at, price, first?}] */
  duelHistory(key, i) { return this.duel.get(`${key}|${i}`) || []; }

  /** Fair probability of side i at time t (last record at or before t; the first one if t is earlier). */
  fairAt(key, i, t) {
    const h = this.fair.get(key);
    if (!h || !h.length) return null;
    let rec = h[0];
    for (const r of h) { if (r.at <= t) rec = r; else break; }
    return i === 0 ? rec.p : 1 - rec.p;
  }

  /**
   * Since Duel last changed this side (or since we first saw it), how far did Polymarket move?
   * Returns { since, unchangedMs, delta (probability of side i, now - then), lags, last } or null.
   */
  signal(key, i, now = Date.now(), { minMove = 0.03, minMs = 60e3 } = {}) {
    const h = this.duelHistory(key, i);
    const f = this.fair.get(key);
    if (!h.length || !f || !f.length) return null;
    const last = h[h.length - 1];
    const then = this.fairAt(key, i, last.at), nowP = this.fairAt(key, i, now);
    if (then == null || nowP == null) return null;
    const delta = nowP - then, unchangedMs = now - last.at;
    return {
      since: last.at, unchangedMs, delta, changed: h.length > 1 ? { from: h[h.length - 2].price, to: last.price, at: last.at } : null,
      lags: Math.abs(delta) >= minMove && unchangedMs >= minMs,
    };
  }
}
