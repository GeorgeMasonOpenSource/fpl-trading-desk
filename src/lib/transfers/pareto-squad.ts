import { runLpOptimiser, type LpPlayer, type LpOptimiserResult } from './lp-optimiser';

/**
 * Pareto-optimal squad picker.
 *
 * The standard LP maximises a single objective: total xPts. But FPL
 * managers care about three things:
 *
 *   1. EV     — max projected points
 *   2. Robustness — minimum exposure to a single team's failure
 *      (e.g. don't stack 3 Arsenal players who all blank together)
 *   3. Differential — score points your mini-league rivals don't have
 *
 * No single squad maximises all three at once. The Pareto front is the
 * set of squads where you can't improve one objective without sacrificing
 * another. We return THREE points on the front:
 *
 *   - "EV-max"          — straight LP, same as before
 *   - "Robust"          — LP with a penalty on intra-team concentration
 *   - "Differential"    — LP with a penalty on rival-EO (high-EO players
 *     get a discount because everyone else has them too)
 *
 * The user picks based on their risk profile + mini-league standing.
 * A 1st-place manager runs Robust; a chaser runs Differential.
 *
 * Implementation: three separate LP runs with different objective
 * coefficients. Each takes <1s; the user sees the three results
 * side-by-side and chooses.
 */

export interface ParetoSquadResult {
  variant: 'ev_max' | 'robust' | 'differential';
  label: string;
  squad: LpPlayer[];
  totalXpts: number;
  /** Helper metric: max-team concentration (Σ players from one club). */
  maxTeamConcentration: number;
  /** Avg effective-ownership of squad in user's mini-league. */
  meanEffectiveOwnership: number;
}

export interface ParetoSquadInput {
  candidatePool: LpPlayer[];
  bank: number;
  freeTransfers: number;
  allowHits: boolean;
  maxHits: number;
  /** EO of each player in the user's mini-league (0..100 percentage). */
  effectiveOwnership?: Map<number, number>;
  /** Force player to be in / out of every squad. */
  forceInclude?: Set<number>;
  forceExclude?: Set<number>;
}

export async function runParetoSquad(input: ParetoSquadInput): Promise<ParetoSquadResult[]> {
  const eo = input.effectiveOwnership ?? new Map();

  // ── Variant 1: EV-max ──────────────────────────────────────────────
  // The vanilla LP — already implemented. Just run with raw xptsHorizon.
  const evRes = await runLpOptimiser({
    candidatePool: input.candidatePool,
    bank: input.bank,
    freeTransfers: input.freeTransfers,
    allowHits: input.allowHits,
    maxHits: input.maxHits,
    xiFirst: true,
    forceInclude: input.forceInclude,
    forceExclude: input.forceExclude
  });

  // ── Variant 2: Robust ──────────────────────────────────────────────
  // Penalise intra-team concentration by docking each player's xPts by a
  // factor of how many of their teammates have already been picked.
  // Approximation: scale player's xpts by 1/sqrt(team_size). Players from
  // teams with 1-2 squad members get full credit; 3-per-club hits a 1/√3
  // ≈ 0.58× factor.
  const robustPool = input.candidatePool.map(p => ({
    ...p,
    // We can't know team_size inside the LP since selection is what we're
    // solving for. So as a proxy: pre-penalise high-priced players whose
    // teams have lots of other high-priced players (concentration risk).
    // Use a simple haircut: subtract a small constant for each teammate
    // also in the candidate pool above £6m.
    xptsHorizon: p.xptsHorizon * (1 - 0.05 * teamHeavyPlayerCount(p, input.candidatePool))
  }));
  const robustRes = await runLpOptimiser({
    candidatePool: robustPool,
    bank: input.bank,
    freeTransfers: input.freeTransfers,
    allowHits: input.allowHits,
    maxHits: input.maxHits,
    xiFirst: true,
    forceInclude: input.forceInclude,
    forceExclude: input.forceExclude
  });

  // ── Variant 3: Differential ────────────────────────────────────────
  // Reward low-EO picks; penalise template picks. The differential value
  // of a player is roughly xPts × (1 - EO%/100). A 5xPts player at 60%
  // EO contributes 5 × 0.4 = 2 to differentials; at 5% EO contributes
  // 5 × 0.95 = 4.75 — so we'd prefer the low-EO player when EO is
  // available.
  //
  // To avoid the LP just picking the worst players, blend with raw EV:
  //   adjusted = 0.6 × xpts + 0.4 × (xpts × (1 - eo/100))
  //            = xpts × (0.6 + 0.4 × (1 - eo/100))
  //            = xpts × (1 - 0.4 × eo/100)
  // A 100% EO player gets 0.6× weight; 0% EO gets full 1.0× weight.
  const diffPool = input.candidatePool.map(p => {
    const eoPct = eo.get(p.playerId) ?? 0;
    return {
      ...p,
      xptsHorizon: p.xptsHorizon * (1 - 0.4 * eoPct / 100)
    };
  });
  const diffRes = await runLpOptimiser({
    candidatePool: diffPool,
    bank: input.bank,
    freeTransfers: input.freeTransfers,
    allowHits: input.allowHits,
    maxHits: input.maxHits,
    xiFirst: true,
    forceInclude: input.forceInclude,
    forceExclude: input.forceExclude
  });

  return [
    summariseResult('ev_max',       'Max EV',           evRes,     input.candidatePool, eo),
    summariseResult('robust',       'Robust',           robustRes, input.candidatePool, eo),
    summariseResult('differential', 'Differential',     diffRes,   input.candidatePool, eo)
  ];
}

function teamHeavyPlayerCount(p: LpPlayer, pool: LpPlayer[]): number {
  // Count of other expensive (>£6m) players from this team in the pool.
  return pool.filter(q => q.teamId === p.teamId && q.playerId !== p.playerId && q.cost >= 60).length;
}

function summariseResult(
  variant: ParetoSquadResult['variant'],
  label: string,
  res: LpOptimiserResult,
  rawPool: LpPlayer[],
  eo: Map<number, number>
): ParetoSquadResult {
  // The LP returns the squad with the SCALED xpts. We recompute the raw
  // total against the original pool for an apples-to-apples comparison
  // across variants.
  const rawById = new Map(rawPool.map(p => [p.playerId, p.xptsHorizon]));
  const totalXpts = res.squad15.reduce((s, p) => s + (rawById.get(p.playerId) ?? p.xptsHorizon), 0);

  const teamCounts = new Map<number, number>();
  for (const p of res.squad15) {
    teamCounts.set(p.teamId, (teamCounts.get(p.teamId) ?? 0) + 1);
  }
  const maxTeamConcentration = Math.max(0, ...Array.from(teamCounts.values()));

  const meanEo = res.squad15.length > 0
    ? res.squad15.reduce((s, p) => s + (eo.get(p.playerId) ?? 0), 0) / res.squad15.length
    : 0;

  return {
    variant,
    label,
    squad: res.squad15,
    totalXpts,
    maxTeamConcentration,
    meanEffectiveOwnership: meanEo
  };
}
