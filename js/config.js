// Sport mapping.
//  kind 'classic': Polymarket series  <->  The Odds API sport key (moneyline / 1X2).
//  kind 'esports': Polymarket series  <->  OddsPapi sportId (match, map winners, handicaps, totals).
// series = Polymarket Gamma series_id (see https://gamma-api.polymarket.com/sports).
// outcomes: 2 = moneyline (no draw), 3 = 1X2 (home / draw / away).
// Everything here can be overridden from the "Advanced" settings panel.
export const DEFAULT_SPORTS = [
  { id: 'cs2',        label: 'Counter-Strike',    kind: 'esports', series: 10310, papi: 17 },
  { id: 'dota2',      label: 'Dota 2',            kind: 'esports', series: 10309, papi: 16 },
  { id: 'lol',        label: 'League of Legends', kind: 'esports', series: 10311, papi: 18 },
  { id: 'val',        label: 'Valorant',          kind: 'esports', series: 10369, papi: 61 },
  { id: 'cod',        label: 'Call of Duty',      kind: 'esports', series: 10427, papi: 56 },
  { id: 'r6',         label: 'Rainbow Six',       kind: 'esports', series: 10432, papi: 58 },
  { id: 'hok',        label: 'Honor of Kings',    kind: 'esports', series: 10434, papi: 65 },
  { id: 'mlbb',       label: 'Mobile Legends',    kind: 'esports', series: 10426, papi: 83 },
  { id: 'nba',        label: 'NBA',               kind: 'classic', series: 10345, odds: 'basketball_nba',            outcomes: 2 },
  { id: 'nfl',        label: 'NFL',               kind: 'classic', series: 12185, odds: 'americanfootball_nfl',      outcomes: 2 },
  { id: 'nhl',        label: 'NHL',               kind: 'classic', series: 10346, odds: 'icehockey_nhl',             outcomes: 2 },
  { id: 'mlb',        label: 'MLB',               kind: 'classic', series: 3,     odds: 'baseball_mlb',              outcomes: 2 },
  { id: 'cfb',        label: 'NCAA Football',     kind: 'classic', series: 12756, odds: 'americanfootball_ncaaf',    outcomes: 2 },
  { id: 'cbb',        label: 'NCAA Basketball',   kind: 'classic', series: 10470, odds: 'basketball_ncaab',          outcomes: 2 },
  { id: 'ufc',        label: 'UFC / MMA',         kind: 'classic', series: 38,    odds: 'mma_mixed_martial_arts',    outcomes: 2 },
  { id: 'epl',        label: 'Premier League',    kind: 'classic', series: 10188, odds: 'soccer_epl',                outcomes: 3 },
  { id: 'laliga',     label: 'La Liga',           kind: 'classic', series: 10193, odds: 'soccer_spain_la_liga',      outcomes: 3 },
  { id: 'seriea',     label: 'Serie A',           kind: 'classic', series: 10203, odds: 'soccer_italy_serie_a',      outcomes: 3 },
  { id: 'bundesliga', label: 'Bundesliga',        kind: 'classic', series: 10194, odds: 'soccer_germany_bundesliga', outcomes: 3 },
  { id: 'ligue1',     label: 'Ligue 1',           kind: 'classic', series: 10195, odds: 'soccer_france_ligue_one',   outcomes: 3 },
  { id: 'ucl',        label: 'Champions League',  kind: 'classic', series: 10204, odds: 'soccer_uefa_champs_league', outcomes: 3 },
  { id: 'mls',        label: 'MLS',               kind: 'classic', series: 10189, odds: 'soccer_usa_mls',            outcomes: 3 },
];

export const DEFAULT_SETTINGS = {
  oddsApiKey: '',
  regions: 'eu,uk',
  bookmakers: '',            // comma-separated bookmaker keys whitelist, empty = all
  oddspapiKey: '',
  oddspapiBooks: '',         // OddsPapi bookmaker slugs, empty = all on your plan
  oddspapiMaxFixtures: 15,   // OddsPapi requests per esport per scan (1 request = 1 match)
  scanHours: 48,             // look this many hours ahead
  sports: ['cs2', 'dota2', 'lol', 'val', 'nba', 'epl'],
  minOdds: 1.01,
  maxOdds: 100,
  maxQuoteAgeMin: 0,         // skip bookmaker prices not updated for this many minutes (0 = off)
  maxProfit: 25,             // above this an arb is almost always a matching / line error — flagged
  search: '',
  sortBy: 'profit',          // profit | time
  currency: 'USD',
  rubRate: 0,                // 0 = do not show RUB
  roundTo: 1,                // round bookmaker stakes to
  theme: 'dark',
  minProfit: 0.5,            // %
  minLiquidity: 0,           // $ available on Polymarket at arb price
  polyFee: 0,                // extra % on top of Polymarket's own fee schedule (applied automatically)
  exchangeCommission: 2,     // % commission on winnings for exchanges (betfair_ex_*, matchbook, smarkets)
  bankroll: 1000,
  timeTolerance: 6,          // hours between Polymarket and bookmaker start times
  matchThreshold: 0.62,      // 0..1 team-name similarity
  refreshSec: 0,             // 0 = manual
  includeBookOnly: false,    // also show bookmaker-vs-bookmaker arbs
  useOrderBook: true,        // refine Polymarket prices with CLOB order book depth
  corsProxy: '',             // e.g. https://corsproxy.io/?url={url}
  tgToken: '',
  tgChat: '',
  browserNotify: false,
  sportsOverride: '',        // JSON array overriding DEFAULT_SPORTS
};

export const EXCHANGE_KEYS = /(^|[_-])(betfair[_-]?ex|matchbook|smarkets|betdaq|orbitexch|sx\.?bet|prophetx)/i;

// Known aliases (normalized form -> canonical normalized form).
export const ALIASES = {
  'man utd': 'manchester united',
  'man united': 'manchester united',
  'man city': 'manchester city',
  'spurs': 'tottenham hotspur',
  'tottenham': 'tottenham hotspur',
  'wolves': 'wolverhampton wanderers',
  'nottm forest': 'nottingham forest',
  "nott'm forest": 'nottingham forest',
  'newcastle': 'newcastle united',
  'west ham': 'west ham united',
  'brighton': 'brighton and hove albion',
  'brighton hove albion': 'brighton and hove albion',
  'leeds': 'leeds united',
  'psg': 'paris saint germain',
  'paris sg': 'paris saint germain',
  'inter': 'inter milan',
  'internazionale': 'inter milan',
  'ac milan': 'milan',
  'atletico': 'atletico madrid',
  'atl madrid': 'atletico madrid',
  'bayern': 'bayern munich',
  'bayern munchen': 'bayern munich',
  'gladbach': 'borussia monchengladbach',
  'leverkusen': 'bayer leverkusen',
  'dortmund': 'borussia dortmund',
  'la lakers': 'los angeles lakers',
  'la clippers': 'los angeles clippers',
  'ny knicks': 'new york knicks',
  'ny giants': 'new york giants',
  'ny jets': 'new york jets',
  'ny rangers': 'new york rangers',
  'ny islanders': 'new york islanders',
  'sixers': '76ers',
  'niners': '49ers',
  'habs': 'montreal canadiens',
};
