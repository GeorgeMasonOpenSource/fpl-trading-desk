/**
 * LP transfer runner — the glue between the UI and the LP optimiser.
 *
 * Pulls the user's current 15, every active PL player as a candidate, sums
 * each player's xPts across the chosen horizon, then hands the package to
 * runLpOptimiser. Returns a UI-friendly summary including the recommended
 * IN/OUT swaps with full player metadata so the planner can render them.
 *
 * This is what FPLReview calls their "Linear Optimiser" — globally optimal
 * subject to budget + 3-per-club + 1/5/5/3 shape + free-transfer + hits.
 * Replaces the greedy v1 that looked at each slot individually.
 */
import { sql } from '@/lib/db/client';
import { runLpOptimiser, type LpOptimiserResult, type LpPlayer } from './lp-optimiser';

export interface LpPlanInput {
  managerId: number;
  startGameweek: number;
  horizon: 1 | 3 | 6 | 8;       // how many GWs of xPts to sum
  freeTransfers: number;        // user's current FT count (usually 1, sometimes 2)
  allowHits?: boolean;          // default false. true → solver may suggest -4 hits.
  maxHits?: number;             // default 1
}

export interface LpPlanResult {
  feasible: boolean;
  reason?: string;              // populated when feasible=false
  horizon: number;
  totalXpts: number;
  hitsTaken: number;
  bank: number;                 // tenths
  spend: number;                // tenths (positive = paid extra)
  transfersIn: LpUiPlayer[];
  transfersOut: LpUiPlayer[];
  /** The full final 15, ordered by position. */
  finalSquad: LpUiPlayer[];
}

export interface LpUiPlayer {
  playerId: number;
  webName: string;
  position: 'GKP' | 'DEF' | 'MID' | 'FWD';
  teamShort: string;
  cost: number;          // tenths
  sellingPrice: number;  // tenths
  xptsHorizon: number;   // sum of xPts over the chosen horizon
  xptsPerGw: number;     // xptsHorizon / horizon
}

/**
 * Build the LP input and solve. Pulls fresh data from the DB on each call —
 * cheap (one batched query) and matches the post-recompute state.
 */
export async function runLpPlan(input: LpPlanInput): Promise<LpPlanResult> {
  // 1. Resolve the gameweek window for the horizon.
  const gwRows = await sql<Array<{ id: number }>>`
    SELECT id FROM gameweeks
     WHERE id >= ${input.startGameweek}
       AND id <  ${input.startGameweek + input.horizon}
     ORDER BY id ASC
  `;
  const gwIds = gwRows.map(r => r.id);
  if (gwIds.length === 0) {
    return emptyResult(input.horizon, 'No gameweeks in the chosen horizon');
  }

  // 2. Pull the current 15 with their selling price.
  const ownedRows = await sql<Array<{
    player_id: number; selling_price: number | null; web_name: string;
    position: 'GKP'|'DEF'|'MID'|'FWD'; team_id: number; team_short: string;
    now_cost: number;
  }>>`
    SELECT mp.player_id, mp.selling_price,
           p.web_name, p.position, p.team_id, p.now_cost,
           t.short_name AS team_short
      FROM manager_picks mp
      JOIN players p ON p.id = mp.player_id
      JOIN teams   t ON t.id = p.team_id
     WHERE mp.manager_id = ${input.managerId}
       AND mp.gameweek_id = (
         SELECT MAX(gameweek_id) FROM manager_picks
          WHERE manager_id = ${input.managerId}
            AND gameweek_id <= ${input.startGameweek}
       )
  `;
  if (ownedRows.length !== 15) {
    return emptyResult(input.horizon,
      `Expected 15 picks for manager ${input.managerId}; found ${ownedRows.length}. ` +
      `Re-run db:seed to ingest the current squad.`);
  }

  // 3. Pull the user's bank from manager_teams.
  const mgrRows = await sql<Array<{ bank: number }>>`
    SELECT bank FROM manager_teams WHERE manager_id = ${input.managerId}
  `;
  const bank = Number(mgrRows[0]?.bank ?? 0);

  // 4. Pull every active player's summed xPts over the horizon, plus the
  //    metadata the solver needs (position, team_id, now_cost).
  const allPlayers = await sql<Array<{
    id: number; web_name: string;
    position: 'GKP'|'DEF'|'MID'|'FWD'; team_id: number; team_short: string;
    now_cost: number; horizon_xpts: number;
  }>>`
    SELECT p.id, p.web_name, p.position, p.team_id, t.short_name AS team_short,
           p.now_cost,
           COALESCE((
             SELECT SUM(pr.xpts_total)
               FROM projections pr
              WHERE pr.player_id = p.id
                AND pr.gameweek_id = ANY(${gwIds as any})
           ), 0)::float8 AS horizon_xpts
      FROM players p
      JOIN teams   t ON t.id = p.team_id
     WHERE p.status <> 'u'                  -- exclude unavailable
       AND p.now_cost > 0
  `;

  // 5. Build the candidate pool. Each owned player keeps their selling price;
  //    new players use current now_cost.
  const ownedById = new Map(ownedRows.map(r => [r.player_id, r]));
  const pool: LpPlayer[] = allPlayers.map(p => {
    const owned = ownedById.get(p.id);
    return {
      playerId: p.id,
      webName:  p.web_name,
      position: p.position,
      teamId:   p.team_id,
      cost:     Number(p.now_cost),
      sellingPrice: owned ? Number(owned.selling_price ?? p.now_cost) : Number(p.now_cost),
      isCurrentlyOwned: !!owned,
      xptsHorizon: Number(p.horizon_xpts) || 0
    };
  });

  // 6. Solve.
  let result: LpOptimiserResult;
  try {
    result = await runLpOptimiser({
      candidatePool: pool,
      bank,
      freeTransfers: input.freeTransfers,
      allowHits: input.allowHits ?? false,
      maxHits:   input.maxHits   ?? 1
    });
  } catch (err) {
    // The LP package is dynamic-imported and might not be installed.
    return emptyResult(input.horizon, (err as Error).message);
  }
  if (!result.feasible) {
    return emptyResult(input.horizon, 'LP infeasible — likely budget too tight for the constraint set.');
  }

  // 7. Map results back to UI types.
  const toUi = (p: LpPlayer): LpUiPlayer => {
    const meta = allPlayers.find(a => a.id === p.playerId)!;
    return {
      playerId: p.playerId,
      webName:  p.webName,
      position: p.position,
      teamShort: meta?.team_short ?? '???',
      cost:     p.cost,
      sellingPrice: p.sellingPrice,
      xptsHorizon: p.xptsHorizon,
      xptsPerGw:   p.xptsHorizon / input.horizon
    };
  };

  const finalSquad = result.squad15
    .map(toUi)
    .sort((a, b) => positionOrder(a.position) - positionOrder(b.position) || b.xptsPerGw - a.xptsPerGw);

  return {
    feasible: true,
    horizon: input.horizon,
    totalXpts: result.totalXpts,
    hitsTaken: result.hitsTaken,
    bank,
    spend: result.spend,
    transfersIn:  result.transfersIn.map(toUi),
    transfersOut: result.transfersOut.map(toUi),
    finalSquad
  };
}

function emptyResult(horizon: number, reason: string): LpPlanResult {
  return {
    feasible: false, reason, horizon, totalXpts: 0, hitsTaken: 0,
    bank: 0, spend: 0, transfersIn: [], transfersOut: [], finalSquad: []
  };
}

function positionOrder(p: 'GKP'|'DEF'|'MID'|'FWD'): number {
  return p === 'GKP' ? 0 : p === 'DEF' ? 1 : p === 'MID' ? 2 : 3;
}
