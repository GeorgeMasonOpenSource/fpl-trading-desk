import { sql, json } from '@/lib/db/client';
import { autoPick, type AutoPickInput } from '@/lib/pick/autoPick';

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

/** Candidate pool: top-N players per position by 3-GW xPts, respecting cost.
 *  Excludes player_ids already in the squad — without this filter the optimiser
 *  cheerfully suggests transfers to players you already own.
 */
async function loadCandidates(
  startGw: number, position: Position, maxCost: number, excludeIds: number[]
) {
  const exclude = excludeIds.length > 0 ? excludeIds : [-1];
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
      AND p.id NOT IN ${sql(exclude as any)}
    ORDER BY proj.h3 DESC NULLS LAST
    LIMIT 40
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
  // Don't allow buying someone who's already in the squad.
  if (squad.some(s => s.playerId === inc.playerId)) return false;
  const newBank = bank + out.cost - inc.cost;
  if (newBank < 0) return false;
  // Count of inc.teamId in the squad after the swap (squad - out + inc) must be ≤ 3.
  const sameClubAfter =
    squad.filter(s => s.teamId === inc.teamId && s.playerId !== out.playerId).length + 1;
  if (sameClubAfter > 3) return false;
  return true;
}

/**
 * Score a 15-man squad by Starting-XI expected points for a given horizon.
 * Uses the same auto-pick logic as the Pitch view — enumerate every legal
 * formation, pick the highest-xPts XI, double the top scorer (captain).
 *
 * This is the *real* objective. Naively summing xPts across all 15 over-
 * counts the bench, so swapping a 0.1-xPts 4th-sub for a 0.5-xPts 4th-sub
 * gets credited 0.4 points that will never actually score.
 */
function xiPointsForHorizon(squad: SquadPlayer[], horizon: Horizon): number {
  if (squad.length === 0) return 0;
  const inputs: AutoPickInput[] = squad.map(p => ({
    player_id: p.playerId,
    web_name: p.webName,
    pos: p.position,
    team_short: p.teamShort,
    xpts_total: Number(p.expectedPoints[horizon]) || 0
  }));
  return autoPick(inputs).totalXpts;
}

/** Bench utility — small credit so the optimiser still prefers a slightly
 *  better bench when XI scores tie. Calibrated so a 1.0-xPts bench swap
 *  scores ~0.1 — much smaller than a 1.0-xPts XI swap. */
function benchUtility(squad: SquadPlayer[], horizon: Horizon): number {
  const inputs: AutoPickInput[] = squad.map(p => ({
    player_id: p.playerId, web_name: p.webName, pos: p.position,
    team_short: p.teamShort, xpts_total: Number(p.expectedPoints[horizon]) || 0
  }));
  const pick = autoPick(inputs);
  // First bench (sub priority 2) does the heavy lifting; 3rd/4th rarely come on.
  const weights = [0, 0.18, 0.05, 0.02, 0.01];
  return pick.bench.reduce((acc, b) => {
    const w = weights[b.benchOrder ?? 0] ?? 0;
    return acc + w * Number(b.player.xpts_total);
  }, 0);
}

function squadScore(squad: SquadPlayer[], horizon: Horizon): number {
  return xiPointsForHorizon(squad, horizon) + benchUtility(squad, horizon);
}

/**
 * EV delta for swapping `out` → `inc`, scored as the change in
 * (Starting-XI points + small bench utility). Computed per horizon.
 */
function evDeltaXI(
  squad: SquadPlayer[],
  baselineByHorizon: Record<Horizon, number>,
  out: SquadPlayer,
  inc: SquadPlayer
): Record<Horizon, number> {
  const after = squad.map(s => (s.playerId === out.playerId ? inc : s));
  const delta = {} as Record<Horizon, number>;
  for (const h of HORIZONS) {
    delta[h] = squadScore(after, h) - baselineByHorizon[h];
  }
  return delta;
}

/**
 * Rank the top-N single-transfer moves for the given gameweek by Starting-XI
 * EV gain over 1 GW (i.e. "best move for next week"). Used by the Transfer
 * Planner's "Top transfers" table — the user sees a concrete leaderboard
 * rather than just the abstract scenario summary.
 *
 * Returns the raw TransferMove plus convenience fields the UI needs.
 */
export interface RankedTransfer {
  rank: number;
  out: { playerId: number; webName: string; teamShort: string; position: Position; cost: number; xpts1: number };
  in:  { playerId: number; webName: string; teamShort: string; position: Position; cost: number; xpts1: number };
  evGain1: number;
  evGain3: number;
  evGain6: number;
  evGain8: number;
  netCost: number;          // tenths; negative = cash freed
  changesCaptain: boolean;
  startsImmediately: boolean;
}

export async function rankTopTransfers(
  managerId: number,
  startGw: number,
  limit = 10
): Promise<RankedTransfer[]> {
  const squad = await loadSquad(managerId, startGw);
  if (squad.length === 0) return [];
  const bankRows = await sql<Array<{ bank: number }>>`
    SELECT bank FROM manager_teams WHERE manager_id = ${managerId}
  `;
  const startBank = bankRows[0]?.bank ?? 0;

  const ownedIds = squad.map(s => s.playerId);
  const byPos: Record<Position, SquadPlayer[]> = { GKP: [], DEF: [], MID: [], FWD: [] };
  for (const pos of ['GKP', 'DEF', 'MID', 'FWD'] as Position[]) {
    const maxCost = startBank + Math.max(...squad.filter(s => s.position === pos).map(s => s.cost), 40);
    byPos[pos] = await loadCandidates(startGw, pos, maxCost, ownedIds);
  }

  const baseline = {} as Record<Horizon, number>;
  for (const h of HORIZONS) baseline[h] = squadScore(squad, h);

  // Compute who the current captain is — we'll flag transfers that change them.
  const baselinePick = autoPick(squad.map(p => ({
    player_id: p.playerId, web_name: p.webName, pos: p.position,
    team_short: p.teamShort, xpts_total: p.expectedPoints[1]
  })));
  const currentCaptainId = baselinePick.starters.find(s => s.isCaptain)?.player.player_id ?? -1;

  const allMoves: Array<TransferMove & {
    changesCaptain: boolean; startsImmediately: boolean;
  }> = [];
  for (const s of squad) {
    for (const c of byPos[s.position]) {
      if (!isLegalSwap(squad, startBank, s, c)) continue;
      const after = squad.map(p => (p.playerId === s.playerId ? c : p));
      const newPick = autoPick(after.map(p => ({
        player_id: p.playerId, web_name: p.webName, pos: p.position,
        team_short: p.teamShort, xpts_total: p.expectedPoints[1]
      })));
      const newCaptainId = newPick.starters.find(x => x.isCaptain)?.player.player_id ?? -1;
      const startsImmediately = newPick.starters.some(x => x.player.player_id === c.playerId);
      allMoves.push({
        out: s, in: c,
        evDelta: evDeltaXI(squad, baseline, s, c),
        netCost: c.cost - s.cost,
        changesCaptain: newCaptainId !== currentCaptainId,
        startsImmediately
      });
    }
  }

  // XI-first filter. The user explicitly does NOT want bench upgrades crowding
  // the top-10 — they want a strong starting XI, not a strong squad. Filter
  // to moves where the incoming player would actually start in the new XI.
  //
  // Fallback: if the strict XI-only filter would produce < 5 results (e.g. a
  // really thin candidate pool), fall back to the unfiltered list so the user
  // always sees something. In practice this rarely fires.
  const xiOnly = allMoves.filter(m => m.startsImmediately);
  const ranked = xiOnly.length >= 5 ? xiOnly : allMoves;

  // Rank by next-GW EV gain (what the user sees as "points for the next gameweek").
  // Tiebreak: 3-GW EV, then cheaper net cost.
  ranked.sort((a, b) => {
    if (b.evDelta[1] !== a.evDelta[1]) return b.evDelta[1] - a.evDelta[1];
    if (b.evDelta[3] !== a.evDelta[3]) return b.evDelta[3] - a.evDelta[3];
    return a.netCost - b.netCost;
  });

  return ranked.slice(0, limit).map((m, idx) => ({
    rank: idx + 1,
    out: {
      playerId: m.out.playerId, webName: m.out.webName, teamShort: m.out.teamShort,
      position: m.out.position, cost: m.out.cost,
      xpts1: Number(m.out.expectedPoints[1]) || 0
    },
    in: {
      playerId: m.in.playerId, webName: m.in.webName, teamShort: m.in.teamShort,
      position: m.in.position, cost: m.in.cost,
      xpts1: Number(m.in.expectedPoints[1]) || 0
    },
    evGain1: m.evDelta[1],
    evGain3: m.evDelta[3],
    evGain6: m.evDelta[6],
    evGain8: m.evDelta[8],
    netCost: m.netCost,
    changesCaptain: m.changesCaptain,
    startsImmediately: m.startsImmediately
  }));
}

export async function compareTransferScenarios(cfg: OptimiserConfig): Promise<ScenarioResult[]> {
  const squad = await loadSquad(cfg.managerId, cfg.startGameweek);
  if (squad.length === 0) return [];
  const bankRows = await sql<Array<{ bank: number }>>`
    SELECT bank FROM manager_teams WHERE manager_id = ${cfg.managerId}
  `;
  const startBank = bankRows[0]?.bank ?? 0;

  // Candidate pool by position, with already-owned players removed up front so
  // the optimiser doesn't even consider them.
  const ownedIds = squad.map(s => s.playerId);
  const byPos: Record<Position, SquadPlayer[]> = {
    GKP: [], DEF: [], MID: [], FWD: []
  };
  for (const pos of ['GKP', 'DEF', 'MID', 'FWD'] as Position[]) {
    const maxCost = startBank + Math.max(...squad.filter(s => s.position === pos).map(s => s.cost), 40);
    byPos[pos] = await loadCandidates(cfg.startGameweek, pos, maxCost, ownedIds);
  }

  // Baseline = score of the current 15 under auto-pick, per horizon.
  // Every candidate move is compared to this so we measure real Starting-XI
  // gain rather than raw sum-of-15 gain.
  const baseline = {} as Record<Horizon, number>;
  for (const h of HORIZONS) baseline[h] = squadScore(squad, h);

  // 1-move candidates (every squad slot × every candidate of that position)
  const oneMoves: TransferMove[] = [];
  for (const s of squad) {
    for (const c of byPos[s.position]) {
      if (!isLegalSwap(squad, startBank, s, c)) continue;
      oneMoves.push({
        out: s, in: c,
        evDelta: evDeltaXI(squad, baseline, s, c),
        netCost: c.cost - s.cost
      });
    }
  }
  oneMoves.sort((a, b) => b.evDelta[3] - a.evDelta[3]);
  const bestOne = oneMoves[0];

  // 2-move candidates: greedily compose best-1 with best-orthogonal-second.
  // The second move's evDelta is scored against the squad *after* the first
  // move so we count the actual joint gain (cumulative, not double-counted).
  let bestTwo: { moves: [TransferMove, TransferMove]; ev: Record<Horizon, number> } | null = null;
  if (bestOne) {
    const squadAfterFirst = squad.map(s => (s.playerId === bestOne.out.playerId ? bestOne.in : s));
    const bankAfter = startBank + bestOne.out.cost - bestOne.in.cost;
    const baselineAfterFirst = {} as Record<Horizon, number>;
    for (const h of HORIZONS) baselineAfterFirst[h] = squadScore(squadAfterFirst, h);

    for (const s of squadAfterFirst) {
      if (s.playerId === bestOne.in.playerId) continue;
      for (const c of byPos[s.position]) {
        if (c.playerId === bestOne.in.playerId) continue;
        if (!isLegalSwap(squadAfterFirst, bankAfter, s, c)) continue;
        const secondDelta = evDeltaXI(squadAfterFirst, baselineAfterFirst, s, c);
        const second = { out: s, in: c, evDelta: secondDelta, netCost: c.cost - s.cost };
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

  // Indicative wildcard: iteratively pick the move with the best XI EV gain
  // against the current (post-prior-move) squad, until 5 moves are made or no
  // positive-EV move remains. Greedy, not globally optimal, but produces
  // sensible "fix my biggest weaknesses" suggestions.
  let wcSquad = [...squad];
  let wcBank = startBank;
  const wcMoves: TransferMove[] = [];
  for (let iter = 0; iter < 5; iter++) {
    let wcBaseline = {} as Record<Horizon, number>;
    for (const h of HORIZONS) wcBaseline[h] = squadScore(wcSquad, h);
    let bestStep: TransferMove | null = null;
    for (const s of wcSquad) {
      for (const c of byPos[s.position]) {
        if (!isLegalSwap(wcSquad, wcBank, s, c)) continue;
        const d = evDeltaXI(wcSquad, wcBaseline, s, c);
        if (d[6] <= 0) continue;
        if (!bestStep || d[6] > bestStep.evDelta[6]) {
          bestStep = { out: s, in: c, evDelta: d, netCost: c.cost - s.cost };
        }
      }
    }
    if (!bestStep) break;
    wcMoves.push(bestStep);
    wcBank += bestStep.out.cost - bestStep.in.cost;
    wcSquad = wcSquad.map(s => (s.playerId === bestStep!.out.playerId ? bestStep!.in : s));
  }
  const wcEv = wcMoves.reduce((acc, m) => acc + m.evDelta[6], 0);
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
