// Team names: is "FORZE Reload" the same team as "FORZE"? (No — that is the academy.)
// Strict on purpose: a wrong match produces fake arbs, a missed match only hides one game.

// Words that say nothing about which team it is.
const GENERIC = new Set(['team', 'esports', 'esport', 'e', 'sports', 'gaming', 'gg', 'club', 'the', 'clan', 'org', 'cs', 'dota', 'lol', 'gc']);

// Words that turn a team into a DIFFERENT team (academy, second roster, women's roster...).
export const ROSTER_WORDS = new Set([
  'academy', 'acad', 'reload', 'ares', 'nxt', 'next', 'junior', 'juniors', 'jr', 'youth', 'young', 'youngsters',
  'rising', 'talent', 'talents', 'prodigies', 'fe', 'female', 'women', 'woman', 'ladies', 'girls', 'w',
  '2', 'ii', 'b', 'u17', 'u19', 'u20', 'u21', 'u23', 'reserve', 'reserves', 'blue', 'red', 'white', 'black',
  'gold', 'silver', 'mix', 'mixed', 'nova', 'zero', 'one', 'x',
]);

// Same team, different spelling. Keys and values are normalized (see tokens()).
const ALIASES = {
  'navi': 'natus vincere', 'nip': 'ninjas in pyjamas', 'mouz': 'mousesports', 'vp': 'virtus pro',
  'c9': 'cloud9', 'fnc': 'fnatic', 'eg': 'evil geniuses', 'tl': 'liquid', 'faze': 'faze', 'g2': 'g2',
  '100t': '100 thieves', 'nrg': 'nrg', 'sen': 'sentinels', 'loud': 'loud', 'kru': 'kru',
  'big': 'big', 'ence': 'ence', 'ef': 'eternal fire', 'gl': 'gamerlegion', 'ihc': 'ihc',
};

export function tokens(name) {
  const s = String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\.(?=\w)/g, '') // "FORZE.R" stays one word, "bc.game" -> "bcgame"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  let t = s.split(' ').filter(w => w && !GENERIC.has(w));
  const joined = t.join(' ');
  if (ALIASES[joined]) t = ALIASES[joined].split(' ');
  return t;
}

/**
 * How sure we are that two names are the same team: 1 = certain, 0 = different.
 * Values between 0.8 and 1 are "probably" and must not be used for arbs on their own.
 */
export function teamScore(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const ja = ta.join(' '), jb = tb.join(' ');
  if (ja === jb) return 1;
  if (ta.join('') === tb.join('')) return 0.98; // "ex RUSTEC" vs "exRUSTEC"
  const sa = new Set(ta), sb = new Set(tb);
  const onlyA = ta.filter(w => !sb.has(w)), onlyB = tb.filter(w => !sa.has(w));
  // an extra roster word on one side means academy / second team: never the same team
  if ([...onlyA, ...onlyB].some(w => ROSTER_WORDS.has(w))) return 0;
  if (!onlyA.length || !onlyB.length) {
    // one name contains the other: "Aurora" vs "Aurora Gaming" (generic already removed) or "Spirit" vs "Team Spirit"
    const extra = onlyA.length + onlyB.length;
    return extra === 0 ? 1 : 0.9 - 0.05 * Math.min(extra - 1, 2);
  }
  // abbreviation: "FORZE.R" (forzer) vs "FORZE Reload" is intentionally NOT handled — too risky
  return 0;
}
