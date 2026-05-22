/**
 * Team-level market calibration.
 *
 * Convert pre-deadline bookmaker markets (over/under 2.5 goals, both
 * teams to score, team-to-win) into per-team expected goals. These
 * markets are tight and STABLE several hours before kick-off, unlike
 * player-prop markets which mostly settle in the last 60 min before KO.
 *
 * Why it matters: at the FPL deadline (90min before first kick-off) we
 * CAN'T use confirmed-XI player odds, but we CAN use these team-level
 * markets which have been pricing in news since the press conference
 * 2 days prior. Bookmakers aggregate manager quotes, injury reports,
 * training-ground intelligence into a single tight team xG number.
 *
 * Method:
 *   1. Decompose decimal odds into implied probabilities, de-vig at the
 *      market level (sum of 1/odds across all outcomes = over-round).
 *   2. For over/under 2.5: solve λ_h + λ_a (total team xG) such that
 *      P(home + away >= 3) under Poisson matches market-implied P(over).
 *   3. For team-to-win: split λ_total into λ_h and λ_a using the implied
 *      P(home win) under Skellam (or just match-odds Poisson).
 *   4. For BTTS: sanity-check the split.
 *   5. Output a per-team xG number we can blend into team_xg_for.
 *
 * The math here is intentionally simple. The Skellam-style independent-
 * Poisson approach has well-known limitations (under-dispersed for
 * draws), but it's accurate to within ~5% on team-level xG which is
 * good enough for our blend weight.
 */

export interface TeamMarketRow {
  fixtureId: number;
  teamId: number;
  isHome: boolean;
  marketImpliedXg: number;
}

/** De-vig: convert raw decimal odds into a normalised probability set. */
export function devig(decimalOdds: number[]): number[] {
  const probs = decimalOdds.map(o => 1 / o);
  const sum = probs.reduce((a, p) => a + p, 0);
  if (sum === 0) return probs;
  return probs.map(p => p / sum);
}

/**
 * Solve for the total expected goals λ such that
 *   P(Poisson(λ) >= 3) = pOver
 *
 * pOver is the market's implied P(over 2.5) after de-vigging. We use
 * binary search across λ ∈ [0.5, 8] which spans every realistic PL
 * match scoreline.
 */
export function impliedTotalXgFromOver25(pOver: number): number {
  const targetP = Math.max(0.001, Math.min(0.999, pOver));
  // P(Poisson(λ) >= 3) = 1 - exp(-λ) * (1 + λ + λ²/2)
  const pAtLambda = (lam: number) => 1 - Math.exp(-lam) * (1 + lam + (lam * lam) / 2);
  let lo = 0.5, hi = 8.0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (pAtLambda(mid) < targetP) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Split a total xG between home and away using the match-odds market.
 *
 * Given de-vigged P(home), P(draw), P(away) and total λ_total, we want
 * λ_home + λ_away = λ_total and the resulting Skellam(λ_home - λ_away)
 * distribution to match the match-odds.
 *
 * Skellam math: P(home win) = P(goal_diff > 0) under Skellam(λ_h, λ_a).
 * We solve via a simple grid search on λ_h / λ_total ∈ [0.1, 0.9].
 */
export function splitHomeAwayXg(
  lambdaTotal: number,
  pHome: number,
  pDraw: number,
  pAway: number
): { lambdaHome: number; lambdaAway: number } {
  let bestRatio = 0.5;
  let bestErr = Infinity;
  for (let i = 1; i <= 89; i++) {
    const ratio = i / 100;
    const lh = lambdaTotal * ratio;
    const la = lambdaTotal * (1 - ratio);
    const { home, draw, away } = matchProbsFromPoisson(lh, la);
    const err =
      (home - pHome) ** 2 +
      (draw - pDraw) ** 2 +
      (away - pAway) ** 2;
    if (err < bestErr) { bestErr = err; bestRatio = ratio; }
  }
  return {
    lambdaHome: lambdaTotal * bestRatio,
    lambdaAway: lambdaTotal * (1 - bestRatio)
  };
}

/**
 * Independent-Poisson 1X2 probabilities. Sum a 7×7 score grid weighted by
 * Poisson(lh, 0..6) × Poisson(la, 0..6) — accurate to <0.5% for realistic
 * football xG levels. Used by splitHomeAwayXg to find the (lh, la) that
 * best matches the market match-odds.
 */
export function matchProbsFromPoisson(lh: number, la: number): {
  home: number; draw: number; away: number;
} {
  const maxGoals = 6;
  // Pre-compute Poisson PMF.
  const poisson = (lam: number) => {
    const pmf: number[] = [];
    let term = Math.exp(-lam);
    pmf.push(term);
    for (let k = 1; k <= maxGoals; k++) {
      term = (term * lam) / k;
      pmf.push(term);
    }
    return pmf;
  };
  const ph = poisson(lh);
  const pa = poisson(la);
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = ph[h]! * pa[a]!;
      if (h > a)      home += p;
      else if (h < a) away += p;
      else            draw += p;
    }
  }
  return { home, draw, away };
}

/**
 * Top-level helper: given a fixture's over-2.5 and 1X2 odds, compute the
 * market-implied home xG and away xG. Returns null if any odds are
 * missing or implausible.
 */
export function calibrateFixture(input: {
  over25_decimal: number;
  under25_decimal: number;
  home_decimal: number;
  draw_decimal: number;
  away_decimal: number;
}): { lambdaHome: number; lambdaAway: number } | null {
  if ([
    input.over25_decimal, input.under25_decimal,
    input.home_decimal, input.draw_decimal, input.away_decimal
  ].some(x => !Number.isFinite(x) || x <= 1)) return null;

  // De-vig the OU 2.5 pair to get true P(over).
  const [pOver, pUnder] = devig([input.over25_decimal, input.under25_decimal]);
  void pUnder;
  // De-vig the 1X2 trio to get true match-odds.
  const [pHome, pDraw, pAway] = devig([
    input.home_decimal, input.draw_decimal, input.away_decimal
  ]);
  const total = impliedTotalXgFromOver25(pOver!);
  const { lambdaHome, lambdaAway } = splitHomeAwayXg(total, pHome!, pDraw!, pAway!);
  return { lambdaHome, lambdaAway };
}
