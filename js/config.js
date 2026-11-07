// Sport mapping: Polymarket tag slug  <->  The Odds API sport key.
// outcomes: 2 = moneyline (no draw), 3 = 1X2 (home / draw / away).
// Everything here can be overridden from the "Advanced" settings panel.
export const DEFAULT_SPORTS = [
  { id: 'nba',        label: 'NBA',               poly: 'nba',        odds: 'basketball_nba',              outcomes: 2 },
  { id: 'nfl',        label: 'NFL',               poly: 'nfl',        odds: 'americanfootball_nfl',        outcomes: 2 },
  { id: 'nhl',        label: 'NHL',               poly: 'nhl',        odds: 'icehockey_nhl',               outcomes: 2 },
  { id: 'mlb',        label: 'MLB',               poly: 'mlb',        odds: 'baseball_mlb',                outcomes: 2 },
  { id: 'cfb',        label: 'NCAA Football',     poly: 'cfb',        odds: 'americanfootball_ncaaf',      outcomes: 2 },
  { id: 'cbb',        label: 'NCAA Basketball',   poly: 'cbb',        odds: 'basketball_ncaab',            outcomes: 2 },
  { id: 'ufc',        label: 'UFC / MMA',         poly: 'ufc',        odds: 'mma_mixed_martial_arts',      outcomes: 2 },
  { id: 'epl',        label: 'Premier League',    poly: 'epl',        odds: 'soccer_epl',                  outcomes: 3 },
  { id: 'laliga',     label: 'La Liga',           poly: 'la-liga',    odds: 'soccer_spain_la_liga',        outcomes: 3 },
  { id: 'seriea',     label: 'Serie A',           poly: 'serie-a',    odds: 'soccer_italy_serie_a',        outcomes: 3 },
  { id: 'bundesliga', label: 'Bundesliga',        poly: 'bundesliga', odds: 'soccer_germany_bundesliga',   outcomes: 3 },
  { id: 'ligue1',     label: 'Ligue 1',           poly: 'ligue-1',    odds: 'soccer_france_ligue_one',     outcomes: 3 },
  { id: 'ucl',        label: 'Champions League',  poly: 'ucl',        odds: 'soccer_uefa_champs_league',   outcomes: 3 },
  { id: 'mls',        label: 'MLS',               poly: 'mls',        odds: 'soccer_usa_mls',              outcomes: 3 },
];

export const DEFAULT_SETTINGS = {
  oddsApiKey: '',
  regions: 'eu,uk',
  bookmakers: '',            // comma-separated bookmaker keys whitelist, empty = all
  sports: ['nba', 'nfl', 'nhl', 'epl'],
  minProfit: 0.5,            // %
  minLiquidity: 0,           // $ available on Polymarket at arb price
  polyFee: 0,                // % taker fee added to Polymarket cost
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

export const EXCHANGE_KEYS = /(^|_)(betfair_ex|matchbook|smarkets|betdaq)/i;

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
