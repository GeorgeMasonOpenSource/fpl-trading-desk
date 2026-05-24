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

// Import LP solver lazily — three loading strategies tried in sequence
// because Next.js's webpack pass mangles a normal CommonJS require:
//   1. eval('require') — webpack ignores this; gives a native Node require
//      that respects Module.createRequire semantics WITHOUT bundling the
//      package. This is the path that works on Vercel server functions.
//   2. createRequire(import.meta.url) — for plain-Node scripts (tsx) which
//      have import.meta.url but no eval-require sandbox.
//   3. await import(...) with binding rewrite — last resort. Wraps Solve
//      in a closure so the library can mutate its `lastSolvedModel` slot
//      on the closure object, not the frozen ESM namespace.
// `serverComponentsExternalPackages: ['javascript-lp-solver']` keeps the
// package out of the bundle, but we still need one of the loading paths
// above to actually find it at runtime.

let cachedSolver: { Solve: (m: any) => any } | null = null;
let cachedLoadError: string | null = null;

async function loadSolver(): Promise<{ Solve: (m: any) => any }> {
  if (cachedSolver) return cachedSolver;
  const errs: string[] = [];

  // Strategy 1 — eval('require'). Works in Next.js Node-runtime server
  // components on Vercel. The eval prevents webpack from rewriting the
  // call, so we get the real Node global require at runtime.
  try {
    // (0, eval) keeps the indirect-eval form so bundlers don't try to be smart.
    const r: any = (0, eval)('typeof require !== "undefined" ? require : null');
    if (typeof r === 'function') {
      const mod = r('javascript-lp-solver');
      const inner = pickSolver(mod);
      if (inner) {
        cachedSolver = inner;
        return inner;
      }
      errs.push('eval-require: loaded package but no Solve function found');
    } else {
      errs.push('eval-require: require is not available in this runtime');
    }
  } catch (err) {
    errs.push(`eval-require: ${(err as Error).message}`);
  }

  // Strategy 2 — createRequire(import.meta.url). The tsx/Node-script path.
  try {
    const { createRequire } = await import('node:module');
    if (typeof createRequire === 'function') {
      const req = createRequire(import.meta.url);
      const mod = req('javascript-lp-solver');
      const inner = pickSolver(mod);
      if (inner) {
        cachedSolver = inner;
        return inner;
      }
      errs.push('createRequire: loaded but no Solve function');
    } else {
      errs.push('createRequire: not available (node:module bundled to empty)');
    }
  } catch (err) {
    errs.push(`createRequire: ${(err as Error).message}`);
  }

  // Strategy 3 — ESM dynamic import with namespace binding. ESM namespace
  // objects are frozen, so we copy Solve into a plain object that the
  // library can mutate.
  try {
    const mod: any = await import('javascript-lp-solver' as any);
    const inner = pickSolver(mod);
    if (inner && typeof inner.Solve === 'function') {
      // Bind Solve so its internal `this.lastSolvedModel = …` writes land
      // on a mutable object instead of the frozen namespace.
      const container: any = { Solve: null };
      container.Solve = inner.Solve.bind(container);
      cachedSolver = container;
      return container;
    }
    errs.push('esm-import: no Solve function');
  } catch (err) {
    errs.push(`esm-import: ${(err as Error).message}`);
  }

  cachedLoadError = errs.join(' | ');
  throw new Error(
    'LP optimiser needs javascript-lp-solver. ' +
    'Install with: npm install javascript-lp-solver --save. ' +
    `Underlying: ${cachedLoadError}`
  );
}

function pickSolver(mod: any): { Solve: (m: any) => any } | null {
  if (!mod) return null;
  // CJS direct, CJS-via-ESM (.default), and bundler-wrapped shapes.
  const candidates = [mod, mod.default, mod.Solver];
  for (const c of candidates) {
    if (c && typeof c.Solve === 'function') return c;
  }
  // Some versions export Solve as a top-level named function rather than
  // hanging it off an object.
  if (typeof mod.Solve === 'function') return mod;
  return null;
}

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
  // §captain-bonus — when true (default), augment the LP objective with
  // a captain decision variable c_p ∈ {0,1} subject to:
  //   c_p ≤ x_p  (can only captain a squad player)
  //   Σ_p c_p = 1  (exactly one captain)
  //   Σ_p c_p × xpts[p]  added to objective (captain bonus)
  // This stops the optimiser undervaluing premium upgrades — without it,
  // Haaland looks like +5 xpts when in fact he's +10 because he'd be
  // captained. Triple-captain mode multiplies the captain bonus by 2
  // instead of 1 (so total captain multiplier is 3× when tcMode=true).
  captainBonus?: boolean;
  // §triple-captain — when true, treat captain contribution as ×3 instead
  // of ×2 (i.e. bonus coefficient = 2 × xpts not 1 × xpts).
  tcMode?: boolean;
}

export interface LpOptimiserResult {
  feasible: boolean;
  totalXpts: number;
  hitsTaken: number;
  squad15: LpPlayer[];
  transfersIn: LpPlayer[];
  transfersOut: LpPlayer[];
  spend: number;
  /** Captain chosen by the LP. Null if captainBonus disabled or no feasible captain. */
  captain?: LpPlayer | null;
  /** Populated when feasible=false. Explains the specific violation(s). */
  reason?: string;
}

/**
 * Run the LP. Returns a feasible solution or feasible=false if no squad
 * satisfies the constraints (e.g. insufficient budget). Lazy-imports the
 * solver package so the rest of the app compiles without it.
 */
export async function runLpOptimiser(input: LpOptimiserInput): Promise<LpOptimiserResult> {
  // Lazy-load the solver via the multi-strategy loader (see loadSolver above).
  // The library mutates its module object during Solve(), so loadSolver
  // makes sure we hand it a mutable container regardless of how it was
  // imported (CJS require vs. ESM namespace).
  const solver = await loadSolver() as { Solve: (m: SolverModel) => SolverResult };

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
  // Captain bonus on by default — closes the LP's blind spot to premium
  // upgrades. tcMode triples the captain (bonus coefficient = 2 instead of 1).
  const captainBonus = input.captainBonus ?? true;
  const captainCoef  = input.tcMode ? 2 : 1;

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
    if (captainBonus) {
      // c_p = 1 if player is captain. Contributes captainCoef × xpts
      // (1× for normal captain → 2× total; 2× for TC → 3× total).
      // Coupling: c_p ≤ x_p (can only captain a squad player).
      const cKey = `c_${p.playerId}`;
      const captainCoupleKey = `cap_couple_${p.playerId}`;
      const c: Record<string, number> = {
        xpts: captainCoef * p.xptsHorizon,
        total: 0,
        gk: 0, def: 0, mid: 0, fwd: 0,
        cost: 0, sellRev: 0, inIfBought: 0,
        captain_total: 1,
      };
      // GKPs are technically captainable, but in 99% of FPL cases this
      // is a bug not a feature. Block GKP captaincy at the LP level so
      // the solver can't break ties by captaining a £4.0 keeper.
      if (p.position === 'GKP') c['no_gkp_captain'] = 1;
      c[captainCoupleKey] = 1;
      v[captainCoupleKey] = -1;
      variables[cKey] = c;
      ints[cKey] = 1;
      constraints[captainCoupleKey] = { max: 0 };
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
    } : {}),
    ...(captainBonus ? {
      captain_total:    { equal: 1 },
      no_gkp_captain:   { max: 0 }, // sum of c_p × is_gkp must be 0
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
      squad15: [], transfersIn: [], transfersOut: [], spend: 0,
      reason: 'LP relaxation infeasible — likely budget too tight or constraint set contradictory.'
    };
  }
  const totalXpts = r.result as number;
  const hitsTaken = Number(r['hits'] ?? 0);
  const squad15: LpPlayer[] = [];
  for (const p of candidates) {
    if ((r[`p_${p.playerId}`] as number) >= 0.99) squad15.push(p);
  }
  // Extract captain from solver result.
  let captain: LpPlayer | null = null;
  if (captainBonus) {
    for (const p of candidates) {
      if ((r[`c_${p.playerId}`] as number) >= 0.99) {
        captain = p;
        break;
      }
    }
    // Defensive: if LP didn't set a captain (e.g. infeasibility on the
    // captain constraint), fall back to the highest-xpts non-GKP in the
    // squad. Better to have a sensible captain than null.
    if (!captain && squad15.length > 0) {
      const eligible = squad15.filter(p => p.position !== 'GKP');
      captain = eligible.sort((a, b) => b.xptsHorizon - a.xptsHorizon)[0] ?? null;
    }
  }
  const ownedIds = new Set(candidates.filter(p => p.isCurrentlyOwned).map(p => p.playerId));
  const newIds   = new Set(squad15.map(p => p.playerId));
  const transfersIn  = squad15.filter(p => !ownedIds.has(p.playerId));
  const transfersOut = candidates.filter(p => p.isCurrentlyOwned && !newIds.has(p.playerId));
  const spend = transfersIn.reduce((s, p) => s + p.cost, 0)
              - transfersOut.reduce((s, p) => s + p.sellingPrice, 0);

  // ── Post-LP validation ───────────────────────────────────────────────
  // javascript-lp-solver returns feasible:true even when its branch-and-
  // bound search times out / aborts with an integer-infeasible solution
  // (e.g. Σ x_p = 9 instead of 15 because the search tree was too large
  // under the xiFirst formulation). Verify the result honours every hard
  // FPL constraint before handing it to the UI. If anything violates,
  // return feasible:false with a precise reason so the planner falls
  // back to the greedy ranker rather than displaying nonsense.
  const violations: string[] = [];
  if (squad15.length !== 15) {
    violations.push(`squad size ${squad15.length} (expected 15)`);
  }
  const posCount = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of squad15) posCount[p.position]++;
  if (posCount.GKP !== 2) violations.push(`GKP ${posCount.GKP} (expected 2)`);
  if (posCount.DEF !== 5) violations.push(`DEF ${posCount.DEF} (expected 5)`);
  if (posCount.MID !== 5) violations.push(`MID ${posCount.MID} (expected 5)`);
  if (posCount.FWD !== 3) violations.push(`FWD ${posCount.FWD} (expected 3)`);
  // 3-per-club
  const clubCount = new Map<number, number>();
  for (const p of squad15) clubCount.set(p.teamId, (clubCount.get(p.teamId) ?? 0) + 1);
  for (const [tid, n] of clubCount) {
    if (n > 3) violations.push(`${n} players from team_id ${tid} (max 3)`);
  }
  // Budget: must spend ≤ bank + Σ selling-price of dropped owned
  const droppedRevenue = transfersOut.reduce((s, p) => s + p.sellingPrice, 0);
  const maxAllowedSpend = input.bank + droppedRevenue;
  const actualSpend = transfersIn.reduce((s, p) => s + p.cost, 0);
  if (actualSpend > maxAllowedSpend + 0.5) {
    // 0.5 tenths slack for rounding
    violations.push(`spend ${actualSpend} > budget ${maxAllowedSpend} (bank ${input.bank} + sell ${droppedRevenue})`);
  }
  // Transfer count: in.length ≤ freeTransfers + hits (when allowHits)
  const allowedTransfers = input.freeTransfers + (input.allowHits ? hitsTaken : 0);
  if (transfersIn.length > allowedTransfers) {
    violations.push(`${transfersIn.length} transfers in, only ${allowedTransfers} allowed (FT=${input.freeTransfers}${input.allowHits ? `, hits=${hitsTaken}` : ', hits disabled'})`);
  }
  // And transfers in MUST equal transfers out (squad stays at 15).
  if (transfersIn.length !== transfersOut.length) {
    violations.push(`transfer-count mismatch: ${transfersIn.length} in vs ${transfersOut.length} out`);
  }

  if (violations.length > 0) {
    return {
      feasible: false, totalXpts: 0, hitsTaken: 0,
      squad15: [], transfersIn: [], transfersOut: [], spend: 0,
      reason: `LP solver returned an invalid solution (${violations.join('; ')}). Falling back.`
    };
  }

  return { feasible: true, totalXpts, hitsTaken, squad15, transfersIn, transfersOut, spend, captain };
}

function sumOwnedSellingPrice(pool: LpPlayer[]): number {
  return pool.filter(p => p.isCurrentlyOwned).reduce((s, p) => s + p.sellingPrice, 0);
}
