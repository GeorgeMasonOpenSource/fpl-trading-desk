/**
 * LP-based transfer optimiser.
 *
 * Replaces the greedy "swap the worst slot" optimiser with a constrained
 * integer-linear-programming search that finds the GLOBALLY-OPTIMAL set
 * of transfers given:
 *   - budget (current bank + selling prices)
 *   - 3-per-club squad cap
 *   - 1 GKP / 5 DEF / 5 MID / 3 FWD squad shape
 *   - 1 / 2 / WC transfer budget
 *   - multi-horizon EV (1, 3, 6, 8 GW sums)
 *
 * Formulation:
 *
 *   Variables: x_p ∈ {0, 1} for every player p in our candidate pool.
 *              x_p = 1 means "player p is in the final squad of 15".
 *
 *   Maximise: Σ_p x_p × xpts_horizon[p]
 *              minus  -4 × hits_taken
 *
 *   Subject to:
 *     Σ_p x_p = 15
 *     Σ_p x_p × is_gk[p]  = 2
 *     Σ_p x_p × is_def[p] = 5
 *     Σ_p x_p × is_mid[p] = 5
 *     Σ_p x_p × is_fwd[p] = 3
 *     Σ_p x_p × is_in_club[p][c] ≤ 3   for each club c
 *     Σ_p x_p × cost[p]   ≤ budget + Σ_p_in_current_squad (1 - x_p) × selling_price[p]
 *     Σ_p (x_p - currently_owned[p])  ≤ 2 × free_transfers + hits_taken
 *
 * Solved with javascript-lp-solver (a pure-JS branch-and-bound MILP
 * solver). For a ~600-player pool and a single horizon, solve time is
 * <1 second on a laptop.
 *
 * Why this beats the greedy v1:
 *   - Considers ALL 2-transfer permutations, not just (best1) → (best
 *     swap given best1). Local-greedy misses joint optima.
 *   - Honours budget across multiple swaps simultaneously.
 *   - Handles the 3-per-club constraint correctly when stacking Arsenal
 *     or Liverpool assets.
 *   - Optimises over the user's CHOSEN horizon (1, 3, 6, 8 GW), not
 *     just the next GW.
 */

// Import LP solver lazily to avoid breaking compile if the package isn't
// installed yet. The user will `npm install javascript-lp-solver` once.
// Until then we throw a clear error from runLpOptimiser.

interface SolverModel {
  optimize: string;
  opType: 'max' | 'min';
  constraints: Record<string, { equal?: number; max?: number; min?: number }>;
  variables: Record<string, Record<string, number>>;
  ints?: Record<string, 1>;
}

interface SolverResult {
  feasible: boolean;
  result: number;
  bounded?: boolean;
  [varName: string]: number | boolean | undefined;
}

export interface LpPlayer {
  playerId: number;
  webName: string;
  position: 'GKP' | 'DEF' | 'MID' | 'FWD';
  teamId: number;
  cost: number;             // current price in tenths
  sellingPrice: number;     // own players keep their selling price; new players use now_cost
  isCurrentlyOwned: boolean;
  xptsHorizon: number;      // SUM of xPts over the chosen horizon (1, 3, 6, 8 GW)
}

export interface LpOptimiserInput {
  candidatePool: LpPlayer[];
  bank: number;                // current bank in tenths
  freeTransfers: number;       // 1 or 2
  allowHits: boolean;          // if true, additional transfers cost -4 each
  maxHits: number;             // cap on -4 hits (typically 1-2)
  // Optional pre-locked players (e.g. a chip / known captain). x = 1 forced.
  forceInclude?: Set<number>;
  forceExclude?: Set<number>;
  // §XI-first — when true, the objective is the STARTING XI's xPts, NOT
  // the full 15-squad's xPts. The optimiser additionally selects 11 of
  // the 15 to start (1 GK, 3-5 DEF, 2-5 MID, 1-3 FWD), and the 4 bench
  // players contribute only a small "filler" credit (cheap warm bodies).
  // For the final GW of the season, set this to true — there's no
  // benefit to a strong bench when you can't transfer afterwards.
  // Default false for backwards compat.
  xiFirst?: boolean;
  // §bench-filler — when xiFirst, how much weight to give bench player
  // xPts. 0.0 = pure XI (ignore bench entirely), 0.1 = small tie-breaker
  // so the solver still prefers a slightly better bench when XI is tied.
  // Default 0.05.
  benchWeight?: number;
}

export interface LpOptimiserResult {
  feasible: boolean;
  totalXpts: number;
  hitsTaken: number;
  squad15: LpPlayer[];
  transfersIn: LpPlayer[];
  transfersOut: LpPlayer[];
  spend: number;
}

/**
 * Run the LP. Returns a feasible solution or feasible=false if no squad
 * satisfies the constraints (e.g. insufficient budget). Lazy-imports the
 * solver package so the rest of the app compiles without it.
 */
export async function runLpOptimiser(input: LpOptimiserInput): Promise<LpOptimiserResult> {
  // Dynamic require — the package is CommonJS and MUTATES its own module
  // object during Solve() (sets `lastSolvedModel`). ESM dynamic import()
  // returns a frozen Module Namespace Object so the assignment fails with
  // "Cannot set property lastSolvedModel of [object Module] which has only
  // a getter". Use Node's createRequire to load as CommonJS, giving us a
  // mutable export object the library can write to.
  let solver: { Solve: (m: SolverModel) => SolverResult };
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const mod = req('javascript-lp-solver') as any;
    // Some bundlers wrap CJS in .default; handle both shapes.
    const inner = mod && mod.Solve ? mod : (mod && mod.default ? mod.default : mod);
    if (!inner || typeof inner.Solve !== 'function') {
      throw new Error('javascript-lp-solver export shape unexpected — no Solve function found');
    }
    solver = inner;
  } catch (err) {
    throw new Error(
      'LP optimiser needs javascript-lp-solver. ' +
      'Install with: npm install javascript-lp-solver --save. ' +
      `Underlying: ${(err as Error).message}`
    );
  }

  const candidates = input.candidatePool.filter(p =>
    !(input.forceExclude?.has(p.playerId))
  );

  // Build constraint coefficients.
  // For each player, we maximise xptsHorizon[p] × x_p.
  const variables: SolverModel['variables'] = {};
  const ints: SolverModel['ints'] = {};
  const clubIds = new Set(candidates.map(p => p.teamId));

  // Constraints
  // - total = 15
  // - gk = 2, def = 5, mid = 5, fwd = 3
  // - per-club <= 3
  // - cost: sum(x_p × cost[p]) <= bank + sum(currently_owned[p] × sellingPrice[p])
  //         simplification: sum(x_p × buyCost[p]) - sum(currently_owned × sellingPrice) = net spend
  //         net spend <= bank
  // - transfers: x_p = 1 AND owned = 0 → "in". sum(in) - 2*freeTransfers <= hits

  const xiFirst = input.xiFirst ?? false;
  const benchWeight = input.benchWeight ?? 0.05;

  // Declare constraints early — the player loop adds per-player coupling
  // constraints under the §XI-first formulation, so we need the object
  // available before we iterate. The shape constraints (total/gk/def/...)
  // are filled in below.
  const constraints: SolverModel['constraints'] = {};

  // §XI-first formulation:
  //   x_p = 1 means "p is in the 15-squad" (existing variable)
  //   y_p = 1 means "p is in the starting XI" (new variable, only when xiFirst)
  // Constraints: y_p ≤ x_p (can only start if in squad)
  //              Σ y_p = 11
  //              y_GK ∈ [1,1], y_DEF ∈ [3,5], y_MID ∈ [2,5], y_FWD ∈ [1,3]
  // Objective: Σ y_p × xpts[p] + benchWeight × Σ (x_p - y_p) × xpts[p]
  //          = Σ x_p × benchWeight × xpts[p] + Σ y_p × (1 - benchWeight) × xpts[p]
  // i.e. x_p contributes benchWeight × xpts[p] always, y_p contributes the
  // rest only when starting. The solver chooses y_p ≤ x_p so the bench
  // players get only the benchWeight credit.
  for (const p of candidates) {
    const isGk  = p.position === 'GKP' ? 1 : 0;
    const isDef = p.position === 'DEF' ? 1 : 0;
    const isMid = p.position === 'MID' ? 1 : 0;
    const isFwd = p.position === 'FWD' ? 1 : 0;
    // Squad variable x_p
    const v: Record<string, number> = {
      // When xiFirst: x_p contributes only benchWeight × xpts. Otherwise
      // full xpts (backwards-compat to maximise squad EV).
      xpts:    xiFirst ? benchWeight * p.xptsHorizon : p.xptsHorizon,
      total:   1,
      gk:      isGk,
      def:     isDef,
      mid:     isMid,
      fwd:     isFwd,
      cost:    p.isCurrentlyOwned ? 0 : p.cost,        // buy cost when not owned
      sellRev: p.isCurrentlyOwned ? p.sellingPrice : 0, // selling revenue when forced out (we'll handle below)
      inIfBought: p.isCurrentlyOwned ? 0 : 1,           // 1 if this is a transfer in
    };
    for (const c of clubIds) v[`club_${c}`] = p.teamId === c ? 1 : 0;
    variables[`p_${p.playerId}`] = v;
    ints[`p_${p.playerId}`] = 1;

    if (xiFirst) {
      // y_p = 1 if player is in starting XI.
      const y: Record<string, number> = {
        xpts: (1 - benchWeight) * p.xptsHorizon,   // remaining xpts credit
        total: 0,
        gk: 0, def: 0, mid: 0, fwd: 0,
        cost: 0, sellRev: 0, inIfBought: 0,
        xi_total: 1,
        xi_gk:  isGk,
        xi_def: isDef,
        xi_mid: isMid,
        xi_fwd: isFwd,
      };
      // y_p ≤ x_p coupling constraint:
      //   y_p - x_p ≤ 0  →  encoded as a per-player constraint
      const couplingKey = `couple_${p.playerId}`;
      y[couplingKey] = 1;
      v[couplingKey] = -1;
      variables[`y_${p.playerId}`] = y;
      ints[`y_${p.playerId}`] = 1;
      constraints[couplingKey] = { max: 0 };
    }
    // Force-include: pre-fix variable to 1 via tight constraint added below.
  }

  // Add a hits variable: number of -4 hits taken. Costs 4 xPts per unit.
  // hits >= 0, integer, max input.maxHits.
  variables['hits'] = {
    xpts: -4,
    total: 0,
    gk: 0, def: 0, mid: 0, fwd: 0,
    cost: 0, sellRev: 0, inIfBought: 0,
    hits_cap: 1,
    transfer_balance: -1,  // each hit lets us make 1 extra transfer in
  };
  ints['hits'] = 1;

  Object.assign(constraints, {
    total:   { equal: 15 },
    gk:      { equal: 2 },
    def:     { equal: 5 },
    mid:     { equal: 5 },
    fwd:     { equal: 3 },
    // §XI-first — when active, additional constraints on the y_p XI
    // selection. 1 GK + 3-5 DEF + 2-5 MID + 1-3 FWD = 11 starters.
    ...(xiFirst ? {
      xi_total: { equal: 11 },
      xi_gk:    { equal: 1 },
      xi_def:   { min: 3, max: 5 },
      xi_mid:   { min: 2, max: 5 },
      xi_fwd:   { min: 1, max: 3 }
    } : {})
  });
  Object.assign(constraints, {
    // Spend constraint: cost_in - sellRev_owned_not_chosen <= bank.
    // But since we only buy NEW (in) players and sell only displaced
    // owned players, with each owned player either kept (x=1, no sell)
    // or dropped (x=0, sell). The simpler formulation:
    //   sum(x_p × cost[p] when not owned)
    // ≤ bank + sum((1-x_p) × sellingPrice[p] when owned)
    // → sum(x_p × cost[p]_when_not_owned) + sum(x_p × sellingPrice[p]_when_owned)
    //   ≤ bank + sum(sellingPrice[p] for owned)
    // We encode this by using a single 'cost' coefficient that's:
    //   buyCost  if not owned
    //   sellingPrice if owned (so x=1 still uses budget; x=0 frees it)
    // RHS = bank + Σ sellingPrice for currently owned.
    cost:    { max: input.bank + sumOwnedSellingPrice(candidates) }
  });
  for (const c of clubIds) constraints[`club_${c}`] = { max: 3 };
  // Transfer-budget constraint:
  //   total transfers in = sum(x_p × inIfBought)
  //   total transfers in - hits ≤ 2 × freeTransfers
  // (× 2 because every "in" requires a matching "out" — counted as 1 transfer)
  constraints['transfer_balance'] = { max: input.freeTransfers };
  if (input.allowHits) {
    constraints['hits_cap'] = { max: input.maxHits };
  } else {
    constraints['hits_cap'] = { max: 0 };
  }

  // Encode the cost column to reflect the "budget" formulation above.
  for (const p of candidates) {
    const v = variables[`p_${p.playerId}`]!;
    v['cost'] = p.isCurrentlyOwned ? p.sellingPrice : p.cost;
    v['transfer_balance'] = p.isCurrentlyOwned ? 0 : 1;
    if (input.forceInclude?.has(p.playerId)) {
      // Pin to 1 via per-variable equality constraint.
      constraints[`force_${p.playerId}`] = { equal: 1 };
      v[`force_${p.playerId}`] = 1;
    }
  }

  const model: SolverModel = {
    optimize: 'xpts',
    opType: 'max',
    constraints,
    variables,
    ints
  };

  const r = solver.Solve(model);
  if (!r.feasible) {
    return {
      feasible: false, totalXpts: 0, hitsTaken: 0,
      squad15: [], transfersIn: [], transfersOut: [], spend: 0
    };
  }
  const totalXpts = r.result as number;
  const hitsTaken = Number(r['hits'] ?? 0);
  const squad15: LpPlayer[] = [];
  for (const p of candidates) {
    if ((r[`p_${p.playerId}`] as number) >= 0.99) squad15.push(p);
  }
  const ownedIds = new Set(candidates.filter(p => p.isCurrentlyOwned).map(p => p.playerId));
  const newIds   = new Set(squad15.map(p => p.playerId));
  const transfersIn  = squad15.filter(p => !ownedIds.has(p.playerId));
  const transfersOut = candidates.filter(p => p.isCurrentlyOwned && !newIds.has(p.playerId));
  const spend = transfersIn.reduce((s, p) => s + p.cost, 0)
              - transfersOut.reduce((s, p) => s + p.sellingPrice, 0);
  return { feasible: true, totalXpts, hitsTaken, squad15, transfersIn, transfersOut, spend };
}

function sumOwnedSellingPrice(pool: LpPlayer[]): number {
  return pool.filter(p => p.isCurrentlyOwned).reduce((s, p) => s + p.sellingPrice, 0);
}
