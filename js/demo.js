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

/** Fake order books around the Gamma best ask. */
export function demoBooks(tokens, games) {
  const map = new Map();
  const askOf = new Map();
  for (const g of games) for (const o of g.outcomes) {
    if (o.yes) askOf.set(o.yes.token, o.yes.ask);
    if (o.no) askOf.set(o.no.token, o.no.ask);
  }
  for (const t of tokens) {
    const a = askOf.get(t);
    if (a == null) continue;
    map.set(t, [0, 0.01, 0.02, 0.03].map((d, i) => ({ price: (a + d).toFixed(3), size: String([900, 1500, 2500, 4000][i]) })));
  }
  return map;
}
