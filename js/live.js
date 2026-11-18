// Polymarket order books in real time over the public CLOB WebSocket (free).
// Server sends a full "book" per token, then "price_change" for every level that changes.
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

/** Local order book: asks/bids as Map(price -> size). */
export class Book {
  constructor() { this.asks = new Map(); this.bids = new Map(); this.ts = 0; }
  snapshot(msg) {
    this.asks = new Map((msg.asks || []).map(l => [+l.price, +l.size]).filter(([, s]) => s > 0));
    this.bids = new Map((msg.bids || []).map(l => [+l.price, +l.size]).filter(([, s]) => s > 0));
    this.ts = +msg.timestamp || Date.now();
  }
  /** side SELL = an ask level, BUY = a bid level; size 0 removes the level. */
  change(c, ts) {
    const side = String(c.side).toUpperCase() === 'SELL' ? this.asks : this.bids;
    const p = +c.price, s = +c.size;
    if (s > 0) side.set(p, s); else side.delete(p);
    this.ts = +ts || Date.now();
  }
  /** Asks cheapest first, in the shape the REST /books endpoint returns. */
  askLevels() { return [...this.asks].sort((a, b) => a[0] - b[0]).map(([price, size]) => ({ price, size })); }
}

/** Apply one WebSocket message (object or array) to a Map(token -> Book). Returns the tokens that changed. */
export function applyMessage(books, data) {
  const changed = new Set();
  for (const m of [].concat(data || [])) {
    if (m.event_type === 'book' && m.asset_id) {
      let b = books.get(m.asset_id);
      if (!b) books.set(m.asset_id, b = new Book());
      b.snapshot(m); changed.add(m.asset_id);
    } else if (m.event_type === 'price_change') {
      // current format: { price_changes: [{ asset_id, price, size, side }] }; older: { asset_id, changes: [...] }
      const list = m.price_changes || (m.changes || []).map(c => ({ ...c, asset_id: m.asset_id }));
      for (const c of list) {
        const b = books.get(c.asset_id);
        if (!b) continue; // no snapshot yet: wait for it
        b.change(c, m.timestamp); changed.add(c.asset_id);
      }
    }
  }
  return changed;
}

/**
 * Keeps one socket open for a changing set of tokens. onChange(tokens:Set) is called after updates,
 * batched per animation frame so a burst of messages renders once.
 */
export class PolyStream {
  constructor({ onChange, onStatus } = {}) {
    this.books = new Map(); this.tokens = new Set(); this.onChange = onChange || (() => {}); this.onStatus = onStatus || (() => {});
    this.ws = null; this.pending = new Set(); this.retry = 0; this.closed = true;
  }
  /** Replace the token set; reconnects only when tokens were added. */
  watch(tokens) {
    const next = new Set(tokens.filter(Boolean));
    const added = [...next].some(t => !this.tokens.has(t));
    this.tokens = next;
    for (const t of [...this.books.keys()]) if (!next.has(t)) this.books.delete(t);
    if (!next.size) return this.stop();
    this.closed = false;
    if (added || !this.ws) this.connect();
  }
  connect() {
    try { this.ws?.close(); } catch {}
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0; this.onStatus('on');
      ws.send(JSON.stringify({ assets_ids: [...this.tokens], type: 'market' }));
      clearInterval(this.ping); this.ping = setInterval(() => { try { ws.send('PING'); } catch {} }, 10000);
    };
    ws.onmessage = e => {
      let d; try { d = JSON.parse(e.data); } catch { return; } // "PONG"
      for (const t of applyMessage(this.books, d)) this.pending.add(t);
      if (!this.raf) this.raf = (globalThis.requestAnimationFrame || (f => setTimeout(f, 50)))(() => {
        this.raf = null; const ch = this.pending; this.pending = new Set(); if (ch.size) this.onChange(ch);
      });
    };
    ws.onclose = () => {
      clearInterval(this.ping);
      if (this.ws !== ws || this.closed) return;
      this.onStatus('off');
      const wait = Math.min(30000, 1000 * 2 ** this.retry++);
      setTimeout(() => { if (!this.closed && this.ws === ws) this.connect(); }, wait);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  stop() { this.closed = true; clearInterval(this.ping); try { this.ws?.close(); } catch {} this.ws = null; this.onStatus('off'); }
  /** Map(token -> asks) for compare.js, only for books we hold a snapshot of. */
  asks() { return new Map([...this.books].map(([t, b]) => [t, b.askLevels()])); }
}
