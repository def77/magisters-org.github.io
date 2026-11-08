// Synthetic data in the real API shapes, so demo mode exercises the same parsers.
const h = n => new Date(Date.now() + n * 3600e3);
const iso = d => d.toISOString();
const day = d => iso(d).slice(0, 10);

function ml(slug, title, a, b, askA, bidA, start, liq = 25000) {
  return {
    id: slug, slug, title, startTime: iso(start), volume: 120000, liquidity: liq,
    markets: [{
      id: slug + '-ml', question: title, sportsMarketType: 'moneyline', active: true, closed: false,
      outcomes: JSON.stringify([a, b]), outcomePrices: JSON.stringify([String(askA - 0.005), String(1 - askA + 0.005)]),
      clobTokenIds: JSON.stringify([slug + '-A', slug + '-B']), bestAsk: askA, bestBid: bidA,
    }],
  };
}

function x12(slug, title, teams, asks, bids, start) {
  return {
    id: slug, slug, title, startTime: iso(start), volume: 300000, liquidity: 60000,
    markets: teams.map((t, i) => ({
      id: `${slug}-${i}`, question: t === 'Draw' ? `${title}: draw?` : `Will ${t} win on ${day(start)}?`,
      groupItemTitle: t === 'Draw' ? 'Draw' : t, sportsMarketType: 'moneyline', active: true, closed: false,
      outcomes: '["Yes","No"]', outcomePrices: JSON.stringify([String(asks[i]), String(1 - asks[i])]),
      clobTokenIds: JSON.stringify([`${slug}-${i}-Y`, `${slug}-${i}-N`]), bestAsk: asks[i], bestBid: bids[i],
    })),
  };
}

function oe(sport, home, away, start, books) {
  return {
    id: `${sport}-${home}-${away}`, sport_key: sport, commence_time: iso(start), home_team: home, away_team: away,
    bookmakers: Object.entries(books).map(([key, prices]) => ({
      key, title: TITLES[key] || key, last_update: iso(new Date()),
      markets: [{ key: 'h2h', outcomes: Object.entries(prices).map(([name, price]) => ({ name, price })) }],
    })),
  };
}
const TITLES = { pinnacle: 'Pinnacle', betfair_ex_eu: 'Betfair Exchange', williamhill: 'William Hill', unibet_eu: 'Unibet', marathonbet: 'Marathon Bet', onexbet: '1xBet', sport888: '888sport' };

export function demoData() {
  const t1 = h(5), t2 = h(26), t3 = h(8), t4 = h(30), t5 = h(3);
  const gamma = {
    nba: [
      ml('nba-lal-bos-' + day(t1), 'Lakers vs. Celtics', 'Lakers', 'Celtics', 0.41, 0.40, t1),
      ml('nba-gsw-den-' + day(t2), 'Warriors vs. Nuggets', 'Warriors', 'Nuggets', 0.47, 0.46, t2),
      ml('nba-nyk-mia-' + day(t5), 'Knicks vs. Heat', 'Knicks', 'Heat', 0.58, 0.565, t5, 8000),
    ],
    epl: [
      x12('epl-ars-che-' + day(t3), 'Arsenal vs. Chelsea', ['Arsenal', 'Draw', 'Chelsea'], [0.52, 0.25, 0.22], [0.51, 0.24, 0.21], t3),
      x12('epl-mun-liv-' + day(t4), 'Man United vs. Liverpool', ['Manchester United', 'Draw', 'Liverpool'], [0.27, 0.25, 0.47], [0.26, 0.24, 0.46], t4),
    ],
    nhl: [], nfl: [],
  };
  const odds = {
    nba: [
      oe('basketball_nba', 'Los Angeles Lakers', 'Boston Celtics', t1, {
        pinnacle: { 'Los Angeles Lakers': 2.38, 'Boston Celtics': 1.62 },
        marathonbet: { 'Los Angeles Lakers': 2.33, 'Boston Celtics': 1.74 },
        williamhill: { 'Los Angeles Lakers': 2.30, 'Boston Celtics': 1.65 },
      }),
      oe('basketball_nba', 'Golden State Warriors', 'Denver Nuggets', t2, {
        pinnacle: { 'Golden State Warriors': 2.10, 'Denver Nuggets': 1.79 },
        unibet_eu: { 'Golden State Warriors': 2.05, 'Denver Nuggets': 1.80 },
      }),
      oe('basketball_nba', 'New York Knicks', 'Miami Heat', t5, {
        pinnacle: { 'New York Knicks': 1.69, 'Miami Heat': 2.28 },
        onexbet: { 'New York Knicks': 1.70, 'Miami Heat': 2.42 },
      }),
    ],
    epl: [
      oe('soccer_epl', 'Arsenal', 'Chelsea', t3, {
        pinnacle: { Arsenal: 1.93, Draw: 3.95, Chelsea: 4.30 },
        betfair_ex_eu: { Arsenal: 1.98, Draw: 4.1, Chelsea: 4.6 },
        sport888: { Arsenal: 1.90, Draw: 4.2, Chelsea: 4.0 },
      }),
      oe('soccer_epl', 'Manchester United', 'Liverpool', t4, {
        pinnacle: { 'Manchester United': 3.75, Draw: 3.9, Liverpool: 2.02 },
        williamhill: { 'Manchester United': 3.6, Draw: 3.8, Liverpool: 2.0 },
      }),
    ],
    nhl: [], nfl: [],
  };
  return { gamma, odds };
}

/** Fake order books around the Gamma best ask. legs: [{token, ask}] */
export function demoBooks(tokens, legs) {
  const map = new Map();
  const askOf = new Map(legs.filter(l => l && l.token).map(l => [l.token, l.ask]));
  for (const t of tokens) {
    const a = askOf.get(t);
    if (a == null) continue;
    map.set(t, [0, 0.01, 0.02, 0.03].map((d, i) => ({ price: (a + d).toFixed(3), size: String([900, 1500, 2500, 4000][i]) })));
  }
  return map;
}

/* ---------- esports demo: Gamma events + OddsPapi v4 shapes ---------- */
const FEE = { feesEnabled: true, feeSchedule: { rate: 0.05, exponent: 1, takerOnly: true } };
function gm(slug, i, type, question, outcomes, ask, bid, line, group) {
  return { id: `${slug}-${i}`, question, sportsMarketType: type, groupItemTitle: group || question, active: true, closed: false,
    outcomes: JSON.stringify(outcomes), clobTokenIds: JSON.stringify([`${slug}-${i}-a`, `${slug}-${i}-b`]), bestAsk: ask, bestBid: bid, line, ...FEE };
}
function papiOdds(fixtureId, books) {
  const bookmakerOdds = {};
  for (const [slug, markets] of Object.entries(books)) {
    const mk = {};
    for (const [mid, prices] of Object.entries(markets)) {
      const outcomes = {};
      prices.forEach(([oid, price, label], k) => { outcomes[oid] = { players: { 0: { active: true, price, limit: [500, 1500, 3000][k % 3], bookmakerOutcomeId: label || String(oid), changedAt: new Date().toISOString() } } }; });
      mk[mid] = { marketActive: true, outcomes };
    }
    bookmakerOdds[slug] = { bookmakerIsActive: true, suspended: false, fixturePath: `https://example.com/${slug}/${fixtureId}`, markets: mk };
  }
  return { fixtureId, bookmakerOdds };
}

export function demoEsports() {
  const t1 = h(4), t2 = h(9), t3 = h(20);
  const gamma = {
    cs2: [
      { id: 'cs-mgl-mouz', slug: 'cs2-mgl-mouz-' + day(t1), title: 'Counter-Strike: TheMongolz vs MOUZ (BO3) - Demo Masters Playoffs', startTime: iso(t1), markets: [
        gm('cs-mgl-mouz', 0, 'moneyline', 'Counter-Strike: TheMongolz vs MOUZ (BO3)', ['TheMongolz', 'MOUZ'], 0.36, 0.35, null, 'Match Winner'),
        gm('cs-mgl-mouz', 1, 'map_handicap', 'Map Handicap: MOUZ (-1.5) vs TheMongolz (+1.5)', ['MOUZ', 'TheMongolz'], 0.37, 0.36, -1.5),
        gm('cs-mgl-mouz', 2, 'child_moneyline', 'Counter-Strike: TheMongolz vs MOUZ - Map 1 Winner', ['TheMongolz', 'MOUZ'], 0.41, 0.40, null, 'Map 1 Winner'),
        gm('cs-mgl-mouz', 3, 'totals', 'Games Total: O/U 2.5', ['Over', 'Under'], 0.45, 0.44, 2.5, 'O/U 2.5 Games'),
      ] },
      { id: 'cs-eye-icp', slug: 'cs2-eye-icp-' + day(t2), title: 'Counter-Strike: Eyeballers vs IC Prospects (BO3) - Demo League', startTime: iso(t2), markets: [
        gm('cs-eye-icp', 0, 'moneyline', 'Counter-Strike: Eyeballers vs IC Prospects (BO3)', ['Eyeballers', 'IC Prospects'], 0.55, 0.54, null, 'Match Winner'),
        gm('cs-eye-icp', 1, 'child_moneyline', 'Counter-Strike: Eyeballers vs IC Prospects - Map 2 Winner', ['Eyeballers', 'IC Prospects'], 0.83, 0.82, null, 'Map 2 Winner'),
      ] },
    ],
    dota2: [
      { id: 'dota-ts-gg', slug: 'dota2-ts-gg-' + day(t3), title: 'Dota 2: Team Spirit vs Gaimin Gladiators (BO3) - Demo Cup', startTime: iso(t3), markets: [
        gm('dota-ts-gg', 0, 'moneyline', 'Dota 2: Team Spirit vs Gaimin Gladiators (BO3)', ['Team Spirit', 'Gaimin Gladiators'], 0.6, 0.59, null, 'Match Winner'),
      ] },
    ],
  };
  const fixtures = {
    cs2: [
      { id: 'id17demo1', sportId: 17, start: t1, tournament: 'Demo Masters', names: [['MOUZ'], ['The MongolZ', 'MongolZ']], title: 'MOUZ vs The MongolZ' },
      { id: 'id17demo2', sportId: 17, start: t2, tournament: 'Demo League', names: [['Eyeballers'], ['IC Prospects']], title: 'Eyeballers vs IC Prospects' },
    ],
    dota2: [{ id: 'id16demo1', sportId: 16, start: t3, tournament: 'Demo Cup', names: [['Team Spirit'], ['Gaimin Gladiators']], title: 'Team Spirit vs Gaimin Gladiators' }],
  };
  // marketId -> { t: type, p: period, h: handicap, o: [[outcomeId, name], ...] }
  const markets = {
    171: { t: 'moneyline', p: 'result', h: 0, o: [[171, '1'], [172, '2']] },
    173: { t: 'moneyline', p: 'p1', h: 0, o: [[173, '1'], [174, '2']] },
    175: { t: 'moneyline', p: 'p2', h: 0, o: [[175, '1'], [176, '2']] },
    177: { t: 'spreads', p: 'result', h: -1.5, o: [[177, '1'], [178, '2']] },
    179: { t: 'spreads', p: 'result', h: 1.5, o: [[179, '1'], [180, '2']] },
    181: { t: 'totals', p: 'result', h: 2.5, o: [[181, 'Over'], [182, 'Under']] },
    161: { t: 'moneyline', p: 'result', h: 0, o: [[161, '1'], [162, '2']] },
  };
  // participant 1 = MOUZ (swapped vs Polymarket order)
  const odds = {
    id17demo1: papiOdds('id17demo1', {
      pinnacle: { 171: [[171, 1.58], [172, 2.55]], 177: [[177, 2.62, 'home/-1.5'], [178, 1.49, 'away/+1.5']], 181: [[181, 2.12], [182, 1.71]] },
      winline: { 171: [[171, 1.60], [172, 2.50]], 177: [[177, 2.95, 'home/-1.5'], [178, 1.47]], 173: [[173, 1.62], [174, 2.30]] },
      betboom: { 171: [[171, 1.58], [172, 2.48]], 173: [[173, 1.75], [174, 2.10]] },
      thunderpick: { 171: [[171, 1.57], [172, 2.55]], 181: [[181, 2.20], [182, 1.68]] },
    }),
    id17demo2: papiOdds('id17demo2', {
      betboom: { 171: [[171, 1.70], [172, 2.10]], 175: [[175, 1.12], [176, 6.30]] },
      pinnacle: { 171: [[171, 1.80], [172, 2.04]], 175: [[175, 1.17], [176, 5.10]] },
    }),
    id16demo1: papiOdds('id16demo1', { pinnacle: { 161: [[161, 1.62], [162, 2.35]] } }),
  };
  return { gamma, fixtures, markets, odds };
}
