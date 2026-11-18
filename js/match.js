// Team-name normalization and event matching between Polymarket and bookmakers.
import { ALIASES } from './config.js';

const STOP = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'cd', 'sv', 'fk', 'bk', 'the', 'club', 'de', 'calcio', 'ssc', 'us', 'as', 'rc', 'vfb', 'vfl', 'tsg', '1', 'and', 'esports', 'esport', 'gaming', 'team', 'gg']);

export function normalize(name) {
  if (!name) return '';
  let s = String(name)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (ALIASES[s]) s = ALIASES[s];
  return s;
}

function tokens(name) {
  return normalize(name).split(' ').filter(t => t && !STOP.has(t));
}

function bigrams(s) {
  const out = [];
  const t = s.replace(/\s+/g, '');
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

function dice(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.length || !B.length) return a === b ? 1 : 0;
  const counts = new Map();
  for (const x of A) counts.set(x, (counts.get(x) || 0) + 1);
  let inter = 0;
  for (const x of B) {
    const c = counts.get(x);
    if (c) { inter++; counts.set(x, c - 1); }
  }
  return (2 * inter) / (A.length + B.length);
}

/** Similarity of two team names in [0, 1]. */
export function similarity(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const isDrawA = /^(draw|tie|x)$/.test(na), isDrawB = /^(draw|tie|x)$/.test(nb);
  if (isDrawA || isDrawB) return isDrawA && isDrawB ? 1 : 0;

  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return dice(na, nb);
  const sa = new Set(ta), sb = new Set(tb);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const jaccard = inter / (sa.size + sb.size - inter);
  // containment: "Lakers" inside "Los Angeles Lakers"
  const contain = inter / Math.min(sa.size, sb.size);
  const containScore = contain === 1 ? 0.9 : contain * 0.7;
  const d = dice(ta.join(' '), tb.join(' '));
  // abbreviation: "PSG" vs "Paris Saint Germain"
  const initials = (arr) => arr.map(t => t[0]).join('');
  const abbr = (ta.length === 1 && ta[0].length >= 2 && ta[0] === initials(tb)) ||
               (tb.length === 1 && tb[0].length >= 2 && tb[0] === initials(ta)) ? 0.85 : 0;
  return Math.max(jaccard, containScore, d, abbr);
}

/**
 * Map Polymarket outcome names to bookmaker outcome names (bijection).
 * Returns array of bookmaker names aligned to polyNames, or null.
 */
export function alignOutcomes(polyNames, bookNames, threshold) {
  if (polyNames.length !== bookNames.length) return null;
  const n = polyNames.length;
  let best = null, bestScore = -1;
  const perms = permutations([...Array(n).keys()]);
  for (const p of perms) {
    let total = 0, min = 1;
    for (let i = 0; i < n; i++) {
      const s = similarity(polyNames[i], bookNames[p[i]]);
      total += s; min = Math.min(min, s);
    }
    if (min >= threshold && total > bestScore) { bestScore = total; best = p; }
  }
  if (!best) return null;
  return { names: best.map(i => bookNames[i]), score: bestScore / n };
}

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  arr.forEach((x, i) => {
    for (const rest of permutations([...arr.slice(0, i), ...arr.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

/**
 * Find the bookmaker event that matches a Polymarket event.
 * polyEvent: { start: Date|null, dateHint: 'YYYY-MM-DD'|null, outcomes:[{name}] }
 * oddsEvents: [{ start: Date, outcomeNames: [...] }]
 */
export function findMatch(polyEvent, oddsEvents, { timeTolerance = 6, threshold = 0.62 } = {}) {
  const polyNames = polyEvent.outcomes.map(o => o.name);
  let best = null;
  for (const ev of oddsEvents) {
    if (!timeOk(polyEvent, ev.start, timeTolerance)) continue;
    const al = alignOutcomes(polyNames, ev.outcomeNames, threshold);
    if (al && (!best || al.score > best.score)) best = { event: ev, names: al.names, score: al.score };
  }
  return best;
}

function timeOk(polyEvent, bookStart, tolH) {
  if (!bookStart) return true;
  if (polyEvent.start) return Math.abs(polyEvent.start - bookStart) <= tolH * 3600e3;
  if (polyEvent.dateHint) {
    const d = new Date(polyEvent.dateHint + 'T12:00:00Z');
    return Math.abs(d - bookStart) <= 36 * 3600e3;
  }
  return true;
}
