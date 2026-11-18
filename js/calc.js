// Arb calculator: Polymarket shares on one side, a Duel stake on the other.
import { polyCost, polyFee } from './compare.js';

/**
 * input: { price, fee, extraPct, odds, mode: 'bank'|'poly'|'duel', amount, roundDuel }
 *   mode 'bank': amount = total money for both legs
 *   mode 'poly': amount = dollars to spend on Polymarket (fee included)
 *   mode 'duel': amount = Duel stake
 *   roundDuel: round the Duel stake to this step ($1, $5...), then fit Polymarket to it
 * Polymarket shares are rounded down to 0.01.
 */
export function calcArb({ price, fee = null, extraPct = 0, odds, mode = 'bank', amount = 100, roundDuel = 0 }) {
  const q1 = polyCost(price, fee, extraPct), q2 = 1 / odds;
  if (!(price > 0 && price < 1 && odds > 1 && amount > 0)) return null;
  let shares;
  if (mode === 'bank') shares = amount / (q1 + q2);
  else if (mode === 'poly') shares = amount / q1;
  else shares = amount * odds;
  let duelStake = shares * q2;
  if (roundDuel > 0) {
    duelStake = Math.max(roundDuel, Math.round(duelStake / roundDuel) * roundDuel);
    shares = duelStake * odds; // same payout on both sides
  }
  shares = Math.floor(shares * 100) / 100;
  const polyUsd = shares * q1, feeUsd = shares * (polyFee(price, fee) + price * extraPct / 100);
  const total = polyUsd + duelStake;
  const winPoly = shares - total, winDuel = duelStake * odds - total;
  return {
    q1, q2, sum: q1 + q2, shares, polyUsd, feeUsd, duelStake, total,
    winPoly, winDuel, worst: Math.min(winPoly, winDuel), worstPct: Math.min(winPoly, winDuel) / total * 100,
  };
}
