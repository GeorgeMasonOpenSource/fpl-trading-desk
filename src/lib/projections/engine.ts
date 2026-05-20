import { sql, json } from '@/lib/db/client';
import { clamp01, poissonAtLeastOne, shrink } from '@/lib/util/math';
import { classifyStage, weightsForStage } from '@/lib/util/season-stage';
import { fixtureExpectations } from './team-strength';
import type { ProjectionReason, Position } from '@/lib/db/types';

/**
 * Deterministic Projection Engine.
 *
 * For every (player, future fixture) pair we compute expected FPL points,
 * broken into appearance / goals / assists / clean sheets / bonus / saves /
 * pen-save / card / concede / OG components. We also return floor, ceiling,
 * risk, and confidence.
 *
 * Modelling rule (per spec): we do NOT chase last week's goals.
 * Recent xG is shrunk against the player's long-term baseline. Long-term
 * role-adjusted output dominates short sample.
 */

interface PlayerProjectionContext {
  playerId: number;
  fixtureId: number;
  gameweekId: number;
  position: Position;
  isHome: boolean;
  // Minutes distribution from minutes_projections:
  startProb: number;
  sixtyPlusProb: number;
  ninetyProb: number;
  subProb: number;
  benchUnusedProb: number;
  injuryAbsenceProb: number;
  earlySubRisk: number;            // P(started but came off before 60')
  expectedMinutes: number;
  // Baselines:
  baselineXg90: number;
  baselineXa90: number;
  baselineBonus90: number;
  baselineCsShare: number;
  baselineYellow90: number;
  baselineRed90: number;
  baselineSaves90: number;
  // Current-season per-90 from this season's history:
  currentXg90: number | null;
  currentXa90: number | null;
  currentBonus90: number | null;
  currentSampleMinutes: number;
  // Team expected for/against in this fixture:
  teamXgFor: number;
  teamXgAgainst: number;
  cleanSheetProb: number;
  // Shares (set piece, penalty):
  penaltyShare: number;
  setPieceShare: number;
  goalShare: number;       // share of team open-play goal threat
  assistShare: number;     // share of team assist threat
  // 25/26 defensive contribution rate (defensive actions per 90).
  defconPer90: number;
  // Confidence inputs:
  reliability: number;
  minutesConfidence: number;
  // New-signing / manager-change adjustments:
  newSigningPenalty: number;
  managerChangePenalty: number;
}

export interface ProjectionResult {
  xpts_total: number;
  xpts_appearance: number;
  xpts_goals: number;
  xpts_assists: number;
  xpts_clean_sheet: number;
  xpts_bonus: number;
  xpts_saves: number;
  xpts_pen_save: number;
  xpts_cards: number;
  xpts_concede: number;
  xpts_owngoal: number;
  xpts_defcon: number;        // 25/26 defensive-contribution component
  floor: number;
  ceiling: number;
  risk_score: number;
  confidence_score: number;
  reasons: ProjectionReason[];
}

// FPL points-per-goal by position
const POINTS_PER_GOAL: Record<Position, number> = { GKP: 6, DEF: 6, MID: 5, FWD: 4 };
const POINTS_PER_ASSIST = 3;
const CS_POINTS: Record<Position, number> = { GKP: 4, DEF: 4, MID: 1, FWD: 0 };

export function projectPlayer(ctx: PlayerProjectionContext): ProjectionResult {
  const reasons: ProjectionReason[] = [];

  // ---------- 1. Per-90 production (shrunk recent vs baseline) -----------------
  // Equivalent-sample-size shrinkage: small current sample = mostly baseline.
  const priorN = 540;        // 6 PL matches' worth
  const minutesSeen = ctx.currentSampleMinutes;
  const xg90 = shrink(ctx.currentXg90 ?? ctx.baselineXg90, minutesSeen,
                      ctx.baselineXg90, priorN);
  const xa90 = shrink(ctx.currentXa90 ?? ctx.baselineXa90, minutesSeen,
                      ctx.baselineXa90, priorN);
  const bonus90 = shrink(ctx.currentBonus90 ?? ctx.baselineBonus90, minutesSeen,
                          ctx.baselineBonus90, priorN);

  // ---------- 2. Fixture modulation -------------------------------------------
  // Two-source goal expectation, then take the max:
  //   (a) Personal per-90 method: xg90 × minutes × fixture-strength factor.
  //       Good for "process" — describes what the player typically does.
  //   (b) Share-of-team method: team xG for this fixture × player goalShare.
  //       Good for "outcome" — directly tied to how many goals will be scored.
  // The personal method alone collapses when the team's overall xG environment
  // shifts, and the share method alone is harsh on a thin sample. Blend with a
  // 50/50 weighting once the player has 540+ minutes, otherwise lean personal.
  const minutesFactor = ctx.expectedMinutes / 90;
  const fixtureBoost = ctx.teamXgFor / 1.4;
  const goalsPersonal = xg90 * minutesFactor * fixtureBoost;
  const goalsFromShare = ctx.teamXgFor * minutesFactor * ctx.goalShare;
  const shareWeight = clamp01(minutesSeen / 540) * 0.5;  // 0 .. 0.5
  const playerXg = goalsPersonal * (1 - shareWeight) + goalsFromShare * shareWeight;

  const assistsPersonal = xa90 * minutesFactor * fixtureBoost;
  const assistsFromShare = ctx.teamXgFor * minutesFactor * ctx.assistShare * 0.7;
  const playerXa = assistsPersonal * (1 - shareWeight) + assistsFromShare * shareWeight;

  if (ctx.goalShare > 0.1) {
    reasons.push({ kind: 'goal_share', weight: ctx.goalShare, detail: `goal share ${(ctx.goalShare*100).toFixed(0)}% of team xG` });
  }
  if (ctx.assistShare > 0.1) {
    reasons.push({ kind: 'assist_share', weight: ctx.assistShare, detail: `assist share ${(ctx.assistShare*100).toFixed(0)}% of team xA` });
  }

  // Penalty bump: if this player is the penalty taker, add expected pen goals.
  // Approximate: ~0.10 pens awarded per fixture in PL × team-attack adjustment × success rate 0.78
  const expectedPensThisGame = 0.10 * fixtureBoost;
  const playerExpectedPenGoals = ctx.penaltyShare * expectedPensThisGame * 0.78;
  if (playerExpectedPenGoals > 0.01) {
    reasons.push({ kind: 'penalty_share', weight: playerExpectedPenGoals * POINTS_PER_GOAL[ctx.position], detail: `pen share ${(ctx.penaltyShare*100).toFixed(0)}%` });
  }
  const totalGoals = playerXg + playerExpectedPenGoals;

  // ---------- 3. Components ----------------------------------------------------
  // Appearance: 1 pt for 1-59 mins, 2 pts for 60+ mins.
  // sixtyPlusProb already includes the 60-89 and 90+ buckets.
  const xpts_appearance =
    2 * ctx.sixtyPlusProb +
    1 * (ctx.subProb + ctx.earlySubRisk);

  // Goals & assists
  const xpts_goals = totalGoals * POINTS_PER_GOAL[ctx.position];
  const xpts_assists = playerXa * POINTS_PER_ASSIST;

  // Clean sheets: only if you played 60+ minutes
  const csElig = ctx.sixtyPlusProb;
  const xpts_clean_sheet = csElig * ctx.cleanSheetProb * CS_POINTS[ctx.position];

  // Goals conceded penalty: -1 per 2 conceded, GKP/DEF only, 60+ required
  const expectedConcedeBy90 = (ctx.expectedMinutes / 90) * ctx.teamXgAgainst;
  const xpts_concede = (ctx.position === 'GKP' || ctx.position === 'DEF')
    ? -1 * csElig * (expectedConcedeBy90 / 2)
    : 0;

  // Saves: 1 pt per 3 saves, GKP only
  const xpts_saves = ctx.position === 'GKP'
    ? (ctx.expectedMinutes / 90) * (ctx.baselineSaves90 / 3)
    : 0;

  // Pen save: 5 pts × P(pen faced) × P(save)
  const expectedPensFacedThisGame = 0.10 * (ctx.teamXgAgainst / 1.4);
  const xpts_pen_save = ctx.position === 'GKP'
    ? expectedPensFacedThisGame * 0.22 * 5
    : 0;

  // Cards: -1 yellow, -3 red
  const xpts_cards =
    -(ctx.baselineYellow90 * (ctx.expectedMinutes / 90)) * 1
    -(ctx.baselineRed90    * (ctx.expectedMinutes / 90)) * 3;

  // Own goals: rare, approximate from concede × small prob
  const xpts_owngoal = -0.02 * (expectedConcedeBy90 / 1.4);

  // Bonus: baseline bonus/90 scaled by minutes and fixture strength. Set-piece
  // takers grab disproportionately more BPS (corners + indirect FKs = passes
  // into the box) so we apply a small bump if this player is the first or
  // second set-piece option.
  const setPieceBonusBump = ctx.setPieceShare > 0 ? 1 + 0.15 * ctx.setPieceShare : 1;
  const xpts_bonus = bonus90 * (ctx.expectedMinutes / 90) * fixtureBoost * setPieceBonusBump;

  // ---------- 25/26 DEFCON points ---------------------------------------------
  // FPL awards 2 pts when:
  //   - DEF reaches 10+ defensive actions in a match
  //   - MID / FWD reach 12+ defensive actions in a match
  // GKP get the existing saves component, no DEFCON.
  //
  // We model the count as Poisson with rate = defconPer90 × minutes/90, then
  // compute P(count >= threshold). The 2 pts only land if the player also
  // makes the 60' bar (the rule is per-match, but realistically you don't hit
  // 10 actions in 20 minutes anyway, so we condition on sixtyPlus).
  const defconThreshold = ctx.position === 'DEF' ? 10 : 12;
  let xpts_defcon = 0;
  if (ctx.position !== 'GKP' && ctx.defconPer90 > 0) {
    const expectedActions = ctx.defconPer90 * (ctx.expectedMinutes / 90);
    // P(Poisson(lambda) >= k) — small k so just sum k..k+10.
    const lambda = expectedActions;
    let cdf = 0;
    let term = Math.exp(-lambda);
    for (let i = 0; i < defconThreshold; i++) {
      cdf += term;
      term = term * lambda / (i + 1);
    }
    const pDefcon = clamp01(1 - cdf);
    xpts_defcon = pDefcon * 2 * ctx.sixtyPlusProb;
    if (xpts_defcon > 0.1) {
      reasons.push({
        kind: 'defcon',
        weight: xpts_defcon,
        detail: `${expectedActions.toFixed(1)} expected def-actions → P(≥${defconThreshold}) ${(pDefcon*100).toFixed(0)}%`
      });
    }
  }

  // Total
  const xpts_total =
    xpts_appearance + xpts_goals + xpts_assists + xpts_clean_sheet +
    xpts_bonus + xpts_saves + xpts_pen_save + xpts_cards + xpts_concede +
    xpts_owngoal + xpts_defcon;

  // ---------- 4. Floor / Ceiling -----------------------------------------------
  // Floor: outcome where player plays but doesn't score/assist or doesn't play.
  // Ceiling: a "haul" night — at least 1 goal AND at least 1 assist (or 2 goals).
  const pGoal = poissonAtLeastOne(totalGoals);
  const pAssist = poissonAtLeastOne(playerXa);
  const haulProb = pGoal * pAssist + poissonAtLeastOne(totalGoals * totalGoals / 2);
  const floor =
    xpts_appearance * 0.5 +    // half-credit for the appearance points
    xpts_clean_sheet * 0.5 +
    Math.max(-2, xpts_cards) + // floor includes only mild card penalty
    xpts_saves * 0.5;
  const ceiling =
    xpts_total +
    pGoal * POINTS_PER_GOAL[ctx.position] * 0.6 +
    pAssist * POINTS_PER_ASSIST * 0.5 +
    haulProb * 4;             // bonus boost ceiling

  // ---------- 5. Risk & confidence --------------------------------------------
  // Risk: high if rotation risk + injury doubt + low minutes confidence.
  const risk = clamp01(
    0.4 * (1 - ctx.minutesConfidence) +
    0.3 * ctx.injuryAbsenceProb +
    0.2 * (1 - ctx.startProb) +
    0.1 * Math.max(0, 1 - minutesSeen / 540)
  );

  const confidence = clamp01(
    0.4 * ctx.minutesConfidence +
    0.3 * ctx.reliability +
    0.2 * Math.min(1, minutesSeen / 540) -
    ctx.newSigningPenalty - ctx.managerChangePenalty
  );

  // ---------- 6. Reasons (audit trail) -----------------------------------------
  reasons.push({ kind: 'expected_minutes', weight: ctx.expectedMinutes / 90, detail: `${ctx.expectedMinutes.toFixed(0)} expected minutes` });
  reasons.push({ kind: 'team_xg_for', weight: ctx.teamXgFor, detail: `team xG: ${ctx.teamXgFor.toFixed(2)}` });
  reasons.push({ kind: 'team_xg_against', weight: ctx.teamXgAgainst, detail: `team xGA: ${ctx.teamXgAgainst.toFixed(2)}` });
  reasons.push({ kind: 'baseline_xg90', weight: xg90, detail: `xG/90 (shrunk): ${xg90.toFixed(2)}` });
  reasons.push({ kind: 'cs_probability', weight: ctx.cleanSheetProb, detail: `CS prob: ${(ctx.cleanSheetProb*100).toFixed(0)}%` });
  if (ctx.newSigningPenalty > 0)     reasons.push({ kind: 'new_signing_uncertainty', weight: ctx.newSigningPenalty });
  if (ctx.managerChangePenalty > 0)  reasons.push({ kind: 'manager_change_uncertainty', weight: ctx.managerChangePenalty });

  return {
    xpts_total, xpts_appearance, xpts_goals, xpts_assists, xpts_clean_sheet,
    xpts_bonus, xpts_saves, xpts_pen_save, xpts_cards, xpts_concede, xpts_owngoal,
    xpts_defcon,
    floor, ceiling, risk_score: risk, confidence_score: confidence,
    reasons
  };
}

/**
 * Recompute projections for every upcoming fixture in the gameweek.
 * Pulls minutes distribution + baselines + team strengths from the DB and
 * writes results into `projections` (UPSERT) + an append-only snapshot.
 */
export async function recomputeProjectionsForGameweek(gameweekId: number) {
  const stage = classifyStage(gameweekId);
  const weights = weightsForStage(stage);

  const fixtures = await sql<Array<{ id: number; team_h: number; team_a: number }>>`
    SELECT id, team_h, team_a FROM fixtures
    WHERE gameweek_id = ${gameweekId} AND finished = FALSE
  `;

  let written = 0;
  for (const fix of fixtures) {
    const exp = await fixtureExpectations(fix.id);
    if (!exp) continue;

    const players = await sql<Array<{
      id: number; team_id: number; position: Position;
      baseline_xg_per_90: number; baseline_xa_per_90: number;
      baseline_bonus_per_90: number; baseline_cs_share: number;
      baseline_yellow_per_90: number; baseline_red_per_90: number;
      baseline_saves_per_90: number; reliability_index: number;
      start_prob: number; sixty_plus_prob: number; ninety_prob: number;
      sub_prob: number; bench_unused_prob: number; injury_absence_prob: number;
      early_sub_risk: number; expected_minutes: number; minutes_confidence: number;
      current_minutes: number; current_xg: number; current_xa: number; current_bonus: number;
      season_xg: number; season_xa: number; season_bonus: number;
      season_defcon_per_90: number;
      penalties_order: number | null;
      corners_order: number | null; freekicks_order: number | null;
      team_xg_total: number; team_xa_total: number;
      team_motivation: number; team_attacking: number; team_solidity: number;
    }>>`
      SELECT
        p.id, p.team_id, p.position,
        COALESCE(b.baseline_xg_per_90, 0.05)    AS baseline_xg_per_90,
        COALESCE(b.baseline_xa_per_90, 0.05)    AS baseline_xa_per_90,
        COALESCE(b.baseline_bonus_per_90, 0.25) AS baseline_bonus_per_90,
        COALESCE(b.baseline_cs_share, 0.20)     AS baseline_cs_share,
        COALESCE(b.baseline_yellow_per_90, 0.15) AS baseline_yellow_per_90,
        COALESCE(b.baseline_red_per_90, 0.01)    AS baseline_red_per_90,
        COALESCE(b.baseline_saves_per_90, 0)     AS baseline_saves_per_90,
        COALESCE(b.reliability_index, 0.55)      AS reliability_index,
        COALESCE(mp.start_prob, 0)               AS start_prob,
        COALESCE(mp.sixty_plus_prob, 0)          AS sixty_plus_prob,
        COALESCE(mp.ninety_prob, 0)              AS ninety_prob,
        COALESCE(mp.sub_prob, 0)                 AS sub_prob,
        COALESCE(mp.bench_unused_prob, 0)        AS bench_unused_prob,
        COALESCE(mp.injury_absence_prob, 0)      AS injury_absence_prob,
        COALESCE(mp.early_sub_risk, 0)           AS early_sub_risk,
        COALESCE(mp.expected_minutes, 0)         AS expected_minutes,
        COALESCE(mp.minutes_confidence, 0.5)     AS minutes_confidence,
        -- Current-season evidence: prefer the season totals stored on players
        -- (sourced from FPL bootstrap-static, covers the entire PL season).
        -- Fall back to any per-GW history rows we've ingested live.
        GREATEST(COALESCE(p.season_minutes, 0), COALESCE(c.minutes, 0))::numeric AS current_minutes,
        GREATEST(COALESCE(p.season_xg, 0), COALESCE(c.xg, 0))::numeric           AS current_xg,
        GREATEST(COALESCE(p.season_xa, 0), COALESCE(c.xa, 0))::numeric           AS current_xa,
        GREATEST(COALESCE(p.season_bonus, 0), COALESCE(c.bonus, 0))::numeric     AS current_bonus,
        COALESCE(p.season_xg, 0)::numeric                                        AS season_xg,
        COALESCE(p.season_xa, 0)::numeric                                        AS season_xa,
        COALESCE(p.season_bonus, 0)::numeric                                     AS season_bonus,
        COALESCE(p.season_defcon_per_90, 0)::numeric                             AS season_defcon_per_90,
        p.penalties_order,
        p.corners_and_indirect_freekicks_order AS corners_order,
        p.direct_freekicks_order               AS freekicks_order,
        COALESCE(t.season_xg_total, 0)::numeric AS team_xg_total,
        COALESCE(t.season_xa_total, 0)::numeric AS team_xa_total,
        COALESCE(t.motivation_score, 0.7)::numeric AS team_motivation,
        COALESCE(t.attacking_style, 0.5)::numeric AS team_attacking,
        COALESCE(t.defensive_solidity, 0.5)::numeric AS team_solidity
      FROM players p
      JOIN teams t ON t.id = p.team_id
      LEFT JOIN player_baselines b ON b.player_id = p.id
      LEFT JOIN minutes_projections mp
        ON mp.player_id = p.id AND mp.fixture_id = ${fix.id}
      LEFT JOIN LATERAL (
        SELECT
          SUM(minutes) AS minutes,
          SUM(expected_goals)::numeric AS xg,
          SUM(expected_assists)::numeric AS xa,
          SUM(bonus)::numeric AS bonus
        FROM player_gameweek_history WHERE player_id = p.id
      ) c ON TRUE
      WHERE p.team_id IN (${fix.team_h}, ${fix.team_a})
    `;

    // Per-team context map so we can read the OPPONENT's style/solidity for
    // each player (a striker faces the opposing team's defence, not his own).
    const teamCtx = new Map<number, {
      motivation: number; attacking: number; solidity: number;
    }>();
    for (const p of players) {
      teamCtx.set(p.team_id, {
        motivation: Number(p.team_motivation),
        attacking: Number(p.team_attacking),
        solidity: Number(p.team_solidity)
      });
    }

    // Pre-collect override info for this fixture's players in one query.
    const playerIds = players.map(p => p.id);
    const ov = playerIds.length === 0 ? [] : await sql<Array<{
      scope_id: number; kind: string; value: any;
    }>>`
      SELECT scope_id, kind, value FROM manual_overrides
      WHERE scope = 'player' AND active = TRUE
        AND scope_id IN ${sql(playerIds as any)}
        AND (expires_at IS NULL OR expires_at > now())
    `;
    const ovByPlayer = new Map<number, Array<{ kind: string; value: any }>>();
    for (const o of ov) {
      if (!ovByPlayer.has(o.scope_id)) ovByPlayer.set(o.scope_id, []);
      ovByPlayer.get(o.scope_id)!.push({ kind: o.kind, value: o.value });
    }

    const projRows: any[] = [];
    const snapshotRows: any[] = [];

    for (const p of players) {
      const isHome = p.team_id === fix.team_h;
      const opponentTeamId = isHome ? fix.team_a : fix.team_h;
      const opp = teamCtx.get(opponentTeamId) ?? { motivation: 0.7, attacking: 0.5, solidity: 0.5 };
      const own = teamCtx.get(p.team_id)     ?? { motivation: 0.7, attacking: 0.5, solidity: 0.5 };

      // --- Style & motivation modulators -----------------------------------
      // Attackers benefit when the OPPOSITION defence is leaky (solidity < 0.5)
      // and is itself open/attacking (high attacking_style — counter-attacking
      // teams trade chances). Compact low blocks (low attacking, high solidity)
      // suppress xG.
      //   styleMultiplier ∈ [~0.75, ~1.25]
      const styleMultiplier =
        1.0 + 0.25 * (0.5 - opp.solidity) + 0.10 * (opp.attacking - 0.5);
      // Motivation: if your own team is unmotivated, expect more rotation +
      // flatter performances. Multiplies expected minutes' headline output.
      //   motivationMultiplier ∈ [~0.85, 1.0]
      const motivationMultiplier = 0.85 + 0.15 * own.motivation;

      const teamXgFor     = (isHome ? exp.xgHome : exp.xgAway) * styleMultiplier * motivationMultiplier;
      const teamXgAgainst =  isHome ? exp.xgAway : exp.xgHome;
      const cs = isHome ? exp.cleanSheetProbHome : exp.cleanSheetProbAway;

      const playerOv = ovByPlayer.get(p.id) ?? [];
      // Manual overrides take precedence — they're factual ("manager said X
      // takes pens this week"). If unset, derive from the FPL public order
      // fields: penalties_order == 1 means first taker.
      const manualPenShare = playerOv.find(o => o.kind === 'penalty_taker')?.value?.share;
      const penaltyShare =
        manualPenShare != null ? manualPenShare :
        p.penalties_order === 1 ? 0.95 :
        p.penalties_order === 2 ? 0.30 : 0;
      const manualSpShare = playerOv.find(o => o.kind === 'set_piece')?.value?.share;
      const setPieceShare =
        manualSpShare != null ? manualSpShare :
        Math.max(
          p.corners_order === 1 ? 0.9 : p.corners_order === 2 ? 0.4 : 0,
          p.freekicks_order === 1 ? 0.9 : p.freekicks_order === 2 ? 0.4 : 0
        );

      // goal- and assist-share — derived from data so a 35%-of-team-xG striker
      // isn't treated like a fringe forward. We clamp the share to 60% so the
      // model never collapses to "Haaland gets everything"; the rest is shared
      // with the other 10 outfielders implicitly.
      const goalShare   = p.team_xg_total > 0
        ? Math.min(0.60, Number(p.season_xg) / Number(p.team_xg_total))
        : 0.15;
      const assistShare = p.team_xa_total > 0
        ? Math.min(0.60, Number(p.season_xa) / Number(p.team_xa_total))
        : 0.15;

      // Bonus baseline boost — when player_baselines hasn't been computed yet
      // (default 0.25) and we have substantial current-season evidence, use
      // current-season bonus/90 as the baseline so we don't shrink toward 0.25.
      const seasonMins = Number(p.current_minutes) || 0;
      const seasonBonus90 = seasonMins > 540
        ? (Number(p.season_bonus) * 90) / seasonMins
        : Number(p.baseline_bonus_per_90);
      const baselineBonus90 = Math.max(Number(p.baseline_bonus_per_90), seasonBonus90);

      const newSigningPenalty = (p.current_minutes < 270) ? weights.newSigningUncertainty * 0.20 : 0;
      const managerChangePenalty = 0;

      const projection = projectPlayer({
        playerId: p.id, fixtureId: fix.id, gameweekId,
        position: p.position, isHome,
        startProb: p.start_prob, sixtyPlusProb: p.sixty_plus_prob,
        ninetyProb: p.ninety_prob, subProb: p.sub_prob,
        benchUnusedProb: p.bench_unused_prob,
        injuryAbsenceProb: p.injury_absence_prob,
        earlySubRisk: p.early_sub_risk, expectedMinutes: p.expected_minutes,
        baselineXg90: p.baseline_xg_per_90, baselineXa90: p.baseline_xa_per_90,
        baselineBonus90, baselineCsShare: p.baseline_cs_share,
        baselineYellow90: p.baseline_yellow_per_90, baselineRed90: p.baseline_red_per_90,
        baselineSaves90: p.baseline_saves_per_90,
        currentXg90: p.current_minutes ? (p.current_xg * 90) / p.current_minutes : null,
        currentXa90: p.current_minutes ? (p.current_xa * 90) / p.current_minutes : null,
        currentBonus90: p.current_minutes ? (p.current_bonus * 90) / p.current_minutes : null,
        currentSampleMinutes: p.current_minutes,
        teamXgFor, teamXgAgainst, cleanSheetProb: cs,
        penaltyShare, setPieceShare,
        goalShare, assistShare,
        defconPer90: Number(p.season_defcon_per_90) || 0,
        reliability: p.reliability_index,
        minutesConfidence: p.minutes_confidence,
        newSigningPenalty, managerChangePenalty
      });

      projRows.push({
        player_id: p.id, fixture_id: fix.id, gameweek_id: gameweekId,
        xpts_total: projection.xpts_total,
        xpts_appearance: projection.xpts_appearance,
        xpts_goals: projection.xpts_goals,
        xpts_assists: projection.xpts_assists,
        xpts_clean_sheet: projection.xpts_clean_sheet,
        xpts_bonus: projection.xpts_bonus,
        xpts_saves: projection.xpts_saves,
        xpts_pen_save: projection.xpts_pen_save,
        xpts_cards: projection.xpts_cards,
        xpts_concede: projection.xpts_concede,
        xpts_owngoal: projection.xpts_owngoal,
        xpts_defcon: projection.xpts_defcon,
        floor: projection.floor,
        ceiling: projection.ceiling,
        risk_score: projection.risk_score,
        confidence_score: projection.confidence_score,
        // Plain object/array for JSONB columns — postgres.js handles encoding.
        reasons: projection.reasons,
        computed_at: new Date()
      });
      snapshotRows.push({
        gameweek_id: gameweekId,
        player_id: p.id, fixture_id: fix.id,
        payload: projection,
        taken_at: new Date()
      });
      written++;
    }

    if (projRows.length > 0) {
      // Bulk INSERT projections — 1 round-trip per fixture instead of N.
      await sql`
        INSERT INTO projections ${(sql as any)(projRows,
          'player_id', 'fixture_id', 'gameweek_id',
          'xpts_total', 'xpts_appearance', 'xpts_goals', 'xpts_assists', 'xpts_clean_sheet',
          'xpts_bonus', 'xpts_saves', 'xpts_pen_save', 'xpts_cards', 'xpts_concede',
          'xpts_owngoal', 'xpts_defcon',
          'floor', 'ceiling', 'risk_score', 'confidence_score', 'reasons', 'computed_at')}
        ON CONFLICT (player_id, fixture_id) DO UPDATE SET
          xpts_total = EXCLUDED.xpts_total,
          xpts_appearance = EXCLUDED.xpts_appearance,
          xpts_goals = EXCLUDED.xpts_goals,
          xpts_assists = EXCLUDED.xpts_assists,
          xpts_clean_sheet = EXCLUDED.xpts_clean_sheet,
          xpts_bonus = EXCLUDED.xpts_bonus,
          xpts_saves = EXCLUDED.xpts_saves,
          xpts_pen_save = EXCLUDED.xpts_pen_save,
          xpts_cards = EXCLUDED.xpts_cards,
          xpts_concede = EXCLUDED.xpts_concede,
          xpts_owngoal = EXCLUDED.xpts_owngoal,
          xpts_defcon = EXCLUDED.xpts_defcon,
          floor = EXCLUDED.floor,
          ceiling = EXCLUDED.ceiling,
          risk_score = EXCLUDED.risk_score,
          confidence_score = EXCLUDED.confidence_score,
          reasons = EXCLUDED.reasons,
          computed_at = now()
      `;
      await sql`
        INSERT INTO projection_snapshots ${(sql as any)(snapshotRows,
          'gameweek_id', 'player_id', 'fixture_id', 'payload', 'taken_at')}
      `;
    }
  }
  return written;
}
