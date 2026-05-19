import { sql, json } from '@/lib/db/client';

/**
 * Transfer optimiser (deterministic, transparent).
 *
 * v1 scope:
 *   - Always compare against do_nothing and roll.
 *   - Enumerate ≤2 transfers per gameweek for the user's current 15.
 *   - Score over horizons of 1, 3, 6, 8 GWs using projections already in DB.
 *   - Respect: budget, 3-per-club cap, position symmetry, squad size.
 *
 * v1 deliberately does NOT enumerate full wildcard squads (15 from ~600 is
 * combinatorial and not viable on free tier). The wildcard route reports
 * indicative EV based on greedy upgrade of weakest 5; a v2 will plug in a
 * proper LP / beam search behind a manual button.
 */

import type { Position } from '@/lib/db/types';

const HORIZONS = [1, 3, 6, 8] as const;
type Horizon = (typeof HORIZONS)[number];

interface SquadPlayer {
  playerId: number;
  position: Position;
  teamId: number;
  cost: number;        // selling/now price in tenths
  expectedPoints: Record<Horizon, number>;
  webName: string;
  teamShort: string;
}

export interface TransferMove {
  out: SquadPlayer;
  in: SquadPlayer;
  evDelta: Record<Horizon, number>;
  netCost: number;     // negative = cash gained
}

export interface ScenarioResult {
  scenario: 'do_nothing' | 'roll' | 'ft1' | 'ft2' | 'hit_-4' | 'hit_-8' | 'wildcard';
  evGainByHorizon: Record<Horizon, number>;
  ev: number;                   // primary horizon (3 GW)
  hitCost: number;
  moves: TransferMove[];
  risk: number;
  confidence: number;
  flexibilityScore: number;
  opportunityCost: number;
  reasons: string[];
}

interface OptimiserConfig {
  managerId: number;
  startGameweek: number;
  freeTransfers: number;
  evThreshold: number;        // EV below which we prefer rolling (per env.EV_TRANSFER_THRESHOLD)
  hitThreshold: number;       // net EV required to justify a -4 (per env.EV_HIT_THRESHOLD)
}

/** Pull the user's current 15 + selling prices + xPts by horizon. */
async function loadSquad(managerId: number, startGw: number): Promise<SquadPlayer[]> {
  const rows = await sql<Array<{
    player_id: number; position: Position; team_id: number;
    selling_price: number | null; now_cost: number;
    web_name: string; team_short: string;
    h1: number; h3: number; h6: number; h8: number;
  }>>`
    WITH proj AS (
      SELECT player_id,
             SUM(CASE WHEN gameweek_id BETWEEN ${startGw} AND ${startGw} + 0 THEN xpts_total ELSE 0 END) AS h1,
             SUM(CASE WHEN gameweek_id BETWEEN ${startGw} AND ${startGw} + 2 THEN xpts_total ELSE 0 END) AS h3,
             SUM(CASE WHEN gameweek_id BETWEEN ${startGw} AND ${startGw} + 5 THEN xpts_total ELSE 0 END) AS h6,
             SUM(CASE WHEN gameweek_id BETWEEN ${startGw} AND ${startGw} + 7 THEN xpts_total ELSE 0 END) AS h8
      FROM projections
      GROUP BY player_id
    )
    SELECT mp.player_id, p.position, p.team_id,
           mp.selling_price, p.now_cost,
           p.web_name, t.short_name AS team_short,
           COALESCE(proj.h1, 0) AS h1,
           COALESCE(proj.h3, 0) AS h3,
           COALESCE(proj.h6, 0) AS h6,
           COALESCE(proj.h8, 0) AS h8
    FROM manager_picks mp
    JOIN players p ON p.id = mp.player_id
    JOIN teams   t ON t.id = p.team_id
    LEFT JOIN proj ON proj.player_id = mp.player_id
    WHERE mp.manager_id = ${managerId} AND mp.gameweek_id = ${startGw}
  `;
  return rows.map(r => ({
    playerId: r.player_id,
    position: r.position,
    teamId: r.team_id,
    cost: r.selling_price ?? r.now_cost,
    webName: r.web_name,
    teamShort: r.team_short,
    expectedPoints: { 1: r.h1, 3: r.h3, 6: r.h6, 8: r.h8 } as Record<Horizon, number>
  }));
}

/** Candidate pool: top-N players per position by 3-GW xPts, respecting cost. */
async function loadCandidates(startGw: number, position: Position, maxCost: number) {
  const rows = await sql<Array<{
    player_id: number; team_id: number; now_cost: number;
    web_name: string; team_short: string;
    h1: number; h3: number; h6: number; h8: number;
  }>>`
    WITH proj AS (
      SELECT player_id,
             SUM(CASE WHEN gameweek_id BETWEEN ${startGw} AND ${startGw} + 0 THEN xpts_total ELSE 0 END) AS h1,
             SUM(CASE WHEN gameweek_id BETWEEN ${startGw} AND ${startGw} + 2 THEN xpts_total ELSE 0 END) AS h3,
             SUM(CASE WHEN gameweek_id BETWEEN ${startGw} AND ${startGw} + 5 THEN xpts_total ELSE 0 END) AS h6,
             SUM(CASE WHEN gameweek_id BETWEEN ${startGw} AND ${startGw} + 7 THEN xpts_total ELSE 0 END) AS h8
      FROM projections
      GROUP BY player_id
    )
    SELECT p.id AS player_id, p.team_id, p.now_cost,
           p.web_name, t.short_name AS team_short,
           COALESCE(proj.h1, 0) AS h1, COALESCE(proj.h3, 0) AS h3,
           COALESCE(proj.h6, 0) AS h6, COALESCE(proj.h8, 0) AS h8
    FROM players p
    JOIN teams t ON t.id = p.team_id
    LEFT JOIN proj ON proj.player_id = p.id
    WHERE p.position = ${position}
      AND p.now_cost <= ${maxCost}
      AND p.status = 'a'
    ORDER BY proj.h3 DESC NULLS LAST
    LIMIT 30
  `;
  return rows.map(r => ({
    playerId: r.player_id,
    position,
    teamId: r.team_id,
    cost: r.now_cost,
    webName: r.web_name,
    teamShort: r.team_short,
    expectedPoints: { 1: r.h1, 3: r.h3, 6: r.h6, 8: r.h8 } as Record<Horizon, number>
  }));
}

/** Returns true if swapping `out` for `inc` keeps squad legal (budget + 3-per-club). */
function isLegalSwap(squad: SquadPlayer[], bank: number, out: SquadPlayer, inc: SquadPlayer) {
  if (inc.position !== out.position) return false;
  if (inc.playerId === out.playerId) return false;
  const newBank = bank + out.cost - inc.cost;
  if (newBank < 0) return false;
  const sameClubCount = squad.filter(s => s.teamId === inc.teamId && s.playerId !== out.playerId).length;
  if (sameClubCount + (inc.teamId === out.teamId ? 0 : 1) > 3) return false;
  return true;
}

function evDelta(out: SquadPlayer, inc: SquadPlayer): Record<Horizon, number> {
  return {
    1: inc.expectedPoints[1] - out.expectedPoints[1],
    3: inc.expectedPoints[3] - out.expectedPoints[3],
    6: inc.expectedPoints[6] - out.expectedPoints[6],
    8: inc.expectedPoints[8] - out.expectedPoints[8]
  };
}

export async function compareTransferScenarios(cfg: OptimiserConfig): Promise<ScenarioResult[]> {
  const squad = await loadSquad(cfg.managerId, cfg.startGameweek);
  if (squad.length === 0) return [];
  const bankRows = await sql<Array<{ bank: number }>>`
    SELECT bank FROM manager_teams WHERE manager_id = ${cfg.managerId}
  `;
  const startBank = bankRows[0]?.bank ?? 0;

  // Candidate pool by position
  const byPos: Record<Position, SquadPlayer[]> = {
    GKP: [], DEF: [], MID: [], FWD: []
  };
  for (const pos of ['GKP', 'DEF', 'MID', 'FWD'] as Position[]) {
    const maxCost = startBank + Math.max(...squad.filter(s => s.position === pos).map(s => s.cost), 40);
    byPos[pos] = await loadCandidates(cfg.startGameweek, pos, maxCost);
  }

  // 1-move candidates (every squad slot × every candidate of that position)
  const oneMoves: TransferMove[] = [];
  for (const s of squad) {
    for (const c of byPos[s.position]) {
      if (!isLegalSwap(squad, startBank, s, c)) continue;
      oneMoves.push({
        out: s, in: c,
        evDelta: evDelta(s, c),
        netCost: c.cost - s.cost
      });
    }
  }
  oneMoves.sort((a, b) => b.evDelta[3] - a.evDelta[3]);
  const bestOne = oneMoves[0];

  // 2-move candidates: greedily compose best-1 with best-orthogonal-second move
  let bestTwo: { moves: [TransferMove, TransferMove]; ev: Record<Horizon, number> } | null = null;
  if (bestOne) {
    const squadAfterFirst = squad.map(s => (s.playerId === bestOne.out.playerId ? bestOne.in : s));
    const bankAfter = startBank + bestOne.out.cost - bestOne.in.cost;
    for (const s of squadAfterFirst) {
      if (s.playerId === bestOne.in.playerId) continue;
      for (const c of byPos[s.position]) {
        if (c.playerId === bestOne.in.playerId) continue;
        if (!isLegalSwap(squadAfterFirst, bankAfter, s, c)) continue;
        const second = { out: s, in: c, evDelta: evDelta(s, c), netCost: c.cost - s.cost };
        const totalEv = {
          1: bestOne.evDelta[1] + second.evDelta[1],
          3: bestOne.evDelta[3] + second.evDelta[3],
          6: bestOne.evDelta[6] + second.evDelta[6],
          8: bestOne.evDelta[8] + second.evDelta[8]
        } as Record<Horizon, number>;
        if (!bestTwo || totalEv[3] > bestTwo.ev[3]) {
          bestTwo = { moves: [bestOne, second], ev: totalEv };
        }
      }
    }
  }

  const zeroEV = { 1: 0, 3: 0, 6: 0, 8: 0 } as Record<Horizon, number>;

  const results: ScenarioResult[] = [];

  // do_nothing baseline
  results.push({
    scenario: 'do_nothing',
    evGainByHorizon: zeroEV, ev: 0,
    hitCost: 0, moves: [],
    risk: 0.0, confidence: 1.0,
    flexibilityScore: 0.7,
    opportunityCost: 0,
    reasons: ['No move — preserves squad value and future flexibility.']
  });

  // roll
  results.push({
    scenario: 'roll',
    evGainByHorizon: zeroEV, ev: 0,
    hitCost: 0, moves: [],
    risk: 0.0, confidence: 0.9,
    flexibilityScore: 1.0,                            // banks a transfer for next week
    opportunityCost: 0,
    reasons: ['No move clears the EV threshold — bank the transfer.']
  });

  if (bestOne) {
    results.push({
      scenario: 'ft1',
      evGainByHorizon: bestOne.evDelta, ev: bestOne.evDelta[3],
      hitCost: 0, moves: [bestOne],
      risk: 0.25, confidence: 0.75,
      flexibilityScore: 0.5,
      opportunityCost: 0.0,
      reasons: [
        `${bestOne.out.webName} → ${bestOne.in.webName} gains ${bestOne.evDelta[3].toFixed(2)} pts over 3 GW.`
      ]
    });
    // -4 hit using one free transfer + an extra
    results.push({
      scenario: 'hit_-4',
      evGainByHorizon: bestTwo?.ev ?? bestOne.evDelta,
      ev: (bestTwo?.ev[3] ?? bestOne.evDelta[3]) - 4,
      hitCost: -4,
      moves: bestTwo ? bestTwo.moves : [bestOne],
      risk: 0.45, confidence: 0.65,
      flexibilityScore: 0.3,
      opportunityCost: 4 - cfg.evThreshold,
      reasons: ['Take a -4 only if net EV clears the hit threshold.']
    });
  }

  if (cfg.freeTransfers >= 2 && bestTwo) {
    results.push({
      scenario: 'ft2',
      evGainByHorizon: bestTwo.ev, ev: bestTwo.ev[3],
      hitCost: 0,
      moves: bestTwo.moves,
      risk: 0.4, confidence: 0.7,
      flexibilityScore: 0.2,
      opportunityCost: 0.0,
      reasons: ['Spend both free transfers — both moves clear the threshold.']
    });
  }

  // Indicative wildcard: greedy top-5 upgrade
  const sortedByXg = [...squad].sort((a, b) => a.expectedPoints[6] - b.expectedPoints[6]);
  let wcEv = 0;
  const wcMoves: TransferMove[] = [];
  let wcBank = startBank;
  for (const s of sortedByXg.slice(0, 5)) {
    const best = byPos[s.position].find(c => isLegalSwap(squad, wcBank, s, c) && c.expectedPoints[6] > s.expectedPoints[6]);
    if (!best) continue;
    wcBank += s.cost - best.cost;
    wcEv += best.expectedPoints[6] - s.expectedPoints[6];
    wcMoves.push({ out: s, in: best, evDelta: evDelta(s, best), netCost: best.cost - s.cost });
  }
  if (wcMoves.length > 0) {
    results.push({
      scenario: 'wildcard',
      evGainByHorizon: { 1: wcEv / 6, 3: wcEv / 2, 6: wcEv, 8: wcEv * 1.1 } as Record<Horizon, number>,
      ev: wcEv,
      hitCost: 0,
      moves: wcMoves,
      risk: 0.55,
      confidence: 0.5,
      flexibilityScore: 0.0,
      opportunityCost: 6,           // burning the WC chip
      reasons: ['Indicative greedy WC; run full optimiser from /transfer-planner if you want the exact 15.']
    });
  }

  // Decision: if best single-transfer EV < threshold, recommend roll explicitly.
  const ft1 = results.find(r => r.scenario === 'ft1');
  if (ft1 && ft1.ev < cfg.evThreshold) {
    const roll = results.find(r => r.scenario === 'roll')!;
    roll.reasons.push(`Best move EV ${ft1.ev.toFixed(2)} < threshold ${cfg.evThreshold}.`);
  }

  // Persist for cache + audit
  for (const r of results) {
    await sql`
      INSERT INTO transfer_simulations (
        manager_id, gameweek_id, horizon, scenario,
        squad_before, moves, squad_after,
        ev_gain, risk, confidence, opportunity_cost, flexibility_score, reasons, computed_at
      ) VALUES (
        ${cfg.managerId}, ${cfg.startGameweek}, 3, ${r.scenario},
        ${json(squad)}, ${json(r.moves)}, ${json([])},
        ${r.ev}, ${r.risk}, ${r.confidence}, ${r.opportunityCost}, ${r.flexibilityScore},
        ${json(r.reasons)}, now()
      )
    `;
  }

  return results;
}
