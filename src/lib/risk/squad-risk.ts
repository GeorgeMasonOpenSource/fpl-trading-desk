import { sql } from '@/lib/db/client';
import type { Position } from '@/lib/db/types';

/**
 * Squad rotation-risk scoring.
 *
 * WHY THIS EXISTS:
 *   FPL's last 4–6 gameweeks are dominated by rotation. Teams that have
 *   secured their league position (top-4 nailed, safety from relegation,
 *   Europa place locked) start resting starters; managers experiment with
 *   youth; star strikers are subbed at 65'. This wrecks expected-minutes
 *   models that were calibrated on a "play to win every match" prior.
 *
 *   This library computes, per squad player, a composite ROTATION RISK
 *   score that blends the model's pre-existing signals AND surfaces a
 *   "safer swap" suggestion the user can act on. The score is interpreted
 *   downstream as: 0.0–0.30 safe · 0.30–0.60 watch · 0.60+ trim.
 *
 * WHAT GOES INTO THE COMPOSITE:
 *   - 30% (1 - start_prob)             — model's read on whether they start
 *   - 20% early_sub_risk               — they start, but get hooked early
 *   - 15% (1 - minutes_confidence)     — how sure we are about that read
 *   - 15% injury_absence_prob          — known knock / press conference doubt
 *   - 10% (1 - team_motivation)        — team has secured league position
 *   - 10% recent_minutes_decline       — last 3 GWs trending down vs season
 *
 * The blend weights deliberately overweight start_prob + early_sub_risk
 * because END-OF-SEASON ROTATION shows up there first: a manager rests a
 * star by either benching them entirely (start_prob drops) or pulling them
 * at 60' to manage minutes (early_sub_risk spikes).
 *
 * NOT INCLUDED (on purpose):
 *   - xPts. A safer player who scores 1 pt is not "better" than a risky
 *     player who scores 8. The risk score is one input to the user's
 *     decision, not the decision itself.
 *
 * WHAT THE SAFER-SWAP SUGGESTION DOES:
 *   For each player flagged "watch" or "trim", find a same-position player
 *   priced within ±£0.5m with strictly lower risk AND projected xPts within
 *   85% of the outgoing player's 3-GW total. The 85% floor exists so we
 *   don't suggest a downgrade that's just a stat-padding bench fodder.
 */

export type RiskBand = 'safe' | 'watch' | 'trim';

export interface RecentMinutesPoint {
  gameweekId: number;
  minutes: number;
  started: boolean;
}

export interface SaferSwap {
  playerId: number;
  webName: string;
  position: Position;
  teamShort: string;
  cost: number;                      // £ × 10
  xpts3: number;
  compositeRisk: number;             // 0..1
  startProb: number;
  earlySubRisk: number;
}

export interface SquadRiskRow {
  playerId: number;
  webName: string;
  position: Position;
  teamShort: string;
  squadSlot: number;
  cost: number;                      // selling price if known, else now_cost (£ × 10)
  isCaptain: boolean;
  isVice: boolean;
  // Composite + band
  compositeRisk: number;             // 0..1
  band: RiskBand;
  // Component values used to build the composite (so the UI can show "why")
  startProb: number;
  earlySubRisk: number;
  minutesConfidence: number;
  injuryAbsenceProb: number;
  teamMotivation: number;
  // Recent form
  recentMinutes: RecentMinutesPoint[];   // most recent first, up to 3 entries
  recentDeclining: boolean;
  // Projection
  xpts1: number;
  xpts3: number;
  // Human-readable flags ("benched in GW36", "team has secured top-4", etc.)
  flags: string[];
  // Suggested safer alternative — null if no candidate clears the bar
  saferSwap: SaferSwap | null;
}

/* ---------------------------------------------------------------------------
 * Tuning constants — exposed at the top of the module so they're easy to
 * find and reason about. Adjust if backtests say the band thresholds are off.
 * -------------------------------------------------------------------------*/
const WATCH_THRESHOLD = 0.30;
const TRIM_THRESHOLD  = 0.60;

const W_START   = 0.30;
const W_HOOK    = 0.20;
const W_CONF    = 0.15;
const W_INJURY  = 0.15;
const W_TEAM    = 0.10;
const W_TREND   = 0.10;

// Safer-swap candidate filter.
const SWAP_PRICE_BAND = 5;            // ±£0.5m in tenths
const SWAP_MIN_RISK_DELTA = 0.10;     // candidate must be ≥ 0.10 lower in risk
const SWAP_MIN_XPTS_RATIO = 0.85;     // candidate must keep ≥ 85% of out's xpts

function bandFor(risk: number): RiskBand {
  if (risk >= TRIM_THRESHOLD)  return 'trim';
  if (risk >= WATCH_THRESHOLD) return 'watch';
  return 'safe';
}

/**
 * Compute the composite rotation-risk score from individual signals. Each
 * input is clamped to [0,1] before blending; this protects us from rare
 * database NaNs and from team_motivation defaults that haven't been
 * recomputed since seeding.
 */
function computeComposite(p: {
  startProb: number;
  earlySubRisk: number;
  minutesConfidence: number;
  injuryAbsenceProb: number;
  teamMotivation: number;
  recentDeclining: boolean;
}): number {
  const clamp = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  const v =
    W_START   * (1 - clamp(p.startProb)) +
    W_HOOK    * clamp(p.earlySubRisk) +
    W_CONF    * (1 - clamp(p.minutesConfidence)) +
    W_INJURY  * clamp(p.injuryAbsenceProb) +
    W_TEAM    * (1 - clamp(p.teamMotivation)) +
    W_TREND   * (p.recentDeclining ? 1 : 0);
  return Number(v.toFixed(3));
}

/**
 * Trend detection: declining if either of these holds across the last 3
 * finished gameweeks, in chronological order:
 *   - they STARTED only 0 or 1 of them
 *   - they averaged < 60 minutes per GW
 * We deliberately accept either condition rather than both, because either
 * one in isolation is enough to flag "the manager has cooled on them" at
 * end of season.
 */
function detectDecline(recent: RecentMinutesPoint[]): boolean {
  if (recent.length < 2) return false;
  const startsCount = recent.filter(r => r.started).length;
  const avgMins = recent.reduce((a, r) => a + r.minutes, 0) / recent.length;
  return startsCount <= 1 || avgMins < 60;
}

/**
 * Pull the candidate pool for safer-swap suggestions in one batch. We keep
 * the top 60 per position by 3-GW xPts; that's enough to find a same-price
 * alternative for any of the user's 15 players while staying cheap.
 */
async function loadCandidatePool(startGw: number, ownedIds: number[]) {
  const exclude = ownedIds.length > 0 ? ownedIds : [-1];
  const rows = await sql<Array<{
    player_id: number; web_name: string; position: Position;
    now_cost: number; team_short: string;
    xpts_3: number;
    start_prob: number; early_sub_risk: number;
    minutes_confidence: number; injury_absence_prob: number;
    team_motivation: number;
  }>>`
    WITH proj AS (
      SELECT player_id,
             SUM(CASE WHEN gameweek_id BETWEEN ${startGw} AND ${startGw} + 2
                      THEN xpts_total ELSE 0 END) AS xpts_3
        FROM projections
       GROUP BY player_id
    ),
    minutes_now AS (
      SELECT mp.player_id,
             AVG(mp.start_prob)          AS start_prob,
             AVG(mp.early_sub_risk)      AS early_sub_risk,
             AVG(mp.minutes_confidence)  AS minutes_confidence,
             AVG(mp.injury_absence_prob) AS injury_absence_prob
        FROM minutes_projections mp
        JOIN fixtures f ON f.id = mp.fixture_id
       WHERE f.gameweek_id BETWEEN ${startGw} AND ${startGw} + 2
       GROUP BY mp.player_id
    )
    SELECT p.id AS player_id, p.web_name, p.position,
           p.now_cost,
           t.short_name AS team_short,
           COALESCE(proj.xpts_3, 0) AS xpts_3,
           COALESCE(mn.start_prob, 0) AS start_prob,
           COALESCE(mn.early_sub_risk, 0) AS early_sub_risk,
           COALESCE(mn.minutes_confidence, 0.5) AS minutes_confidence,
           COALESCE(mn.injury_absence_prob, 0) AS injury_absence_prob,
           COALESCE(t.motivation_score, 0.7) AS team_motivation
      FROM players p
      JOIN teams t ON t.id = p.team_id
      LEFT JOIN proj      ON proj.player_id = p.id
      LEFT JOIN minutes_now mn ON mn.player_id = p.id
     WHERE p.status = 'a'
       AND p.id NOT IN ${sql(exclude as any)}
  `;
  return rows;
}

/**
 * Main entry — produce a complete risk profile for the user's squad in the
 * given gameweek. The result is sorted by composite risk DESC so the UI
 * shows the riskiest player first.
 */
export async function getSquadRotationRisk(
  managerId: number,
  startGameweek: number
): Promise<SquadRiskRow[]> {
  // 1. The squad itself, joined to the model's per-player signals.
  const squadRows = await sql<Array<{
    player_id: number; squad_slot: number; selling_price: number | null;
    is_captain: boolean; is_vice: boolean;
    web_name: string; position: Position; now_cost: number;
    team_id: number; team_short: string;
    team_motivation: number;
    start_prob: number; early_sub_risk: number;
    minutes_confidence: number; injury_absence_prob: number;
    xpts_1: number; xpts_3: number;
  }>>`
    WITH proj AS (
      SELECT player_id,
             SUM(CASE WHEN gameweek_id = ${startGameweek}
                      THEN xpts_total ELSE 0 END) AS xpts_1,
             SUM(CASE WHEN gameweek_id BETWEEN ${startGameweek} AND ${startGameweek} + 2
                      THEN xpts_total ELSE 0 END) AS xpts_3
        FROM projections
       GROUP BY player_id
    ),
    minutes_now AS (
      SELECT mp.player_id,
             AVG(mp.start_prob)          AS start_prob,
             AVG(mp.early_sub_risk)      AS early_sub_risk,
             AVG(mp.minutes_confidence)  AS minutes_confidence,
             AVG(mp.injury_absence_prob) AS injury_absence_prob
        FROM minutes_projections mp
        JOIN fixtures f ON f.id = mp.fixture_id
       WHERE f.gameweek_id = ${startGameweek}
       GROUP BY mp.player_id
    )
    SELECT mp.player_id, mp.position AS squad_slot, mp.selling_price,
           mp.is_captain, mp.is_vice,
           p.web_name, p.position, p.now_cost,
           p.team_id,
           t.short_name AS team_short,
           COALESCE(t.motivation_score, 0.7) AS team_motivation,
           COALESCE(mn.start_prob, 0) AS start_prob,
           COALESCE(mn.early_sub_risk, 0) AS early_sub_risk,
           COALESCE(mn.minutes_confidence, 0.5) AS minutes_confidence,
           COALESCE(mn.injury_absence_prob, 0) AS injury_absence_prob,
           COALESCE(proj.xpts_1, 0) AS xpts_1,
           COALESCE(proj.xpts_3, 0) AS xpts_3
      FROM manager_picks mp
      JOIN players p ON p.id = mp.player_id
      JOIN teams t   ON t.id = p.team_id
      LEFT JOIN proj      ON proj.player_id = p.id
      LEFT JOIN minutes_now mn ON mn.player_id = p.id
     WHERE mp.manager_id = ${managerId}
       AND mp.gameweek_id = ${startGameweek}
     ORDER BY mp.position
  `;
  if (squadRows.length === 0) return [];

  // 2. Last 3 finished gameweeks of minutes per squad player. We use a
  //    window function so we get exactly 3 most-recent finished rows even
  //    when some GWs are blanks/doubles.
  const squadIds = squadRows.map(r => r.player_id);
  const recentRows = await sql<Array<{
    player_id: number; gameweek_id: number; minutes: number; starts: number;
  }>>`
    SELECT player_id, gameweek_id, minutes, starts
      FROM (
        SELECT pgh.player_id, pgh.gameweek_id, pgh.minutes, pgh.starts,
               ROW_NUMBER() OVER (
                 PARTITION BY pgh.player_id ORDER BY pgh.gameweek_id DESC
               ) AS rn
          FROM player_gameweek_history pgh
          JOIN fixtures f ON f.id = pgh.fixture_id
         WHERE f.finished = TRUE
           AND pgh.player_id IN ${sql(squadIds as any)}
      ) sub
     WHERE rn <= 3
     ORDER BY player_id, gameweek_id DESC
  `;
  const recentByPlayer = new Map<number, RecentMinutesPoint[]>();
  for (const r of recentRows) {
    if (!recentByPlayer.has(r.player_id)) recentByPlayer.set(r.player_id, []);
    recentByPlayer.get(r.player_id)!.push({
      gameweekId: r.gameweek_id,
      minutes: Number(r.minutes),
      started: Number(r.starts) > 0
    });
  }

  // 3. Candidate pool for swap suggestions.
  const candidates = await loadCandidatePool(startGameweek, squadIds);

  // 4. Roll it up per squad player.
  const out: SquadRiskRow[] = [];
  for (const s of squadRows) {
    const recent = recentByPlayer.get(s.player_id) ?? [];
    const decliningRecent = detectDecline(recent);

    const composite = computeComposite({
      startProb: Number(s.start_prob),
      earlySubRisk: Number(s.early_sub_risk),
      minutesConfidence: Number(s.minutes_confidence),
      injuryAbsenceProb: Number(s.injury_absence_prob),
      teamMotivation: Number(s.team_motivation),
      recentDeclining: decliningRecent
    });

    // Human-readable flag construction. Each clause checks an independent
    // condition; we use string flags rather than enum so the UI can show
    // them as comma-separated chips without a translation layer.
    const flags: string[] = [];
    if (Number(s.start_prob) < 0.6) {
      flags.push(`Start prob ${(Number(s.start_prob) * 100).toFixed(0)}%`);
    }
    if (Number(s.early_sub_risk) > 0.25) {
      flags.push(`Early-sub risk ${(Number(s.early_sub_risk) * 100).toFixed(0)}%`);
    }
    if (Number(s.injury_absence_prob) > 0.15) {
      flags.push(`Injury doubt ${(Number(s.injury_absence_prob) * 100).toFixed(0)}%`);
    }
    if (Number(s.team_motivation) < 0.55) {
      flags.push(`${s.team_short} have nothing to play for`);
    }
    if (decliningRecent && recent.length >= 2) {
      const startedCount = recent.filter(r => r.started).length;
      flags.push(`Started ${startedCount}/${recent.length} recent GWs`);
    }
    if (recent.length >= 1 && recent[0]!.minutes === 0) {
      flags.push(`DNP in GW${recent[0]!.gameweekId}`);
    }

    // Safer-swap selection. Same position, price within band, lower risk
    // by at least SWAP_MIN_RISK_DELTA, and projected xPts within
    // SWAP_MIN_XPTS_RATIO of the outgoing player's 3-GW total.
    const cost = s.selling_price ?? s.now_cost;
    let saferSwap: SaferSwap | null = null;
    if (bandFor(composite) !== 'safe') {
      const eligible = candidates
        .filter(c => c.position === s.position)
        .filter(c => Math.abs(c.now_cost - cost) <= SWAP_PRICE_BAND)
        .map(c => ({
          c,
          risk: computeComposite({
            startProb: Number(c.start_prob),
            earlySubRisk: Number(c.early_sub_risk),
            minutesConfidence: Number(c.minutes_confidence),
            injuryAbsenceProb: Number(c.injury_absence_prob),
            teamMotivation: Number(c.team_motivation),
            recentDeclining: false       // unknown without per-candidate history; conservative
          })
        }))
        .filter(x => composite - x.risk >= SWAP_MIN_RISK_DELTA)
        .filter(x => Number(x.c.xpts_3) >= Number(s.xpts_3) * SWAP_MIN_XPTS_RATIO);
      eligible.sort((a, b) => a.risk - b.risk);
      const best = eligible[0];
      if (best) {
        saferSwap = {
          playerId: best.c.player_id,
          webName: best.c.web_name,
          position: best.c.position,
          teamShort: best.c.team_short,
          cost: best.c.now_cost,
          xpts3: Number(best.c.xpts_3),
          compositeRisk: best.risk,
          startProb: Number(best.c.start_prob),
          earlySubRisk: Number(best.c.early_sub_risk)
        };
      }
    }

    out.push({
      playerId: s.player_id,
      webName: s.web_name,
      position: s.position,
      teamShort: s.team_short,
      squadSlot: s.squad_slot,
      cost,
      isCaptain: s.is_captain,
      isVice: s.is_vice,
      compositeRisk: composite,
      band: bandFor(composite),
      startProb: Number(s.start_prob),
      earlySubRisk: Number(s.early_sub_risk),
      minutesConfidence: Number(s.minutes_confidence),
      injuryAbsenceProb: Number(s.injury_absence_prob),
      teamMotivation: Number(s.team_motivation),
      recentMinutes: recent,
      recentDeclining: decliningRecent,
      xpts1: Number(s.xpts_1),
      xpts3: Number(s.xpts_3),
      flags,
      saferSwap
    });
  }

  out.sort((a, b) => b.compositeRisk - a.compositeRisk);
  return out;
}
