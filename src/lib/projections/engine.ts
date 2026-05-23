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
  // §model-sharpening additions:
  // Recency-weighted per-90 — when present, dominates the shrunk current
  // value because it already captures form trajectory better than a flat sum.
  recencyXg90: number | null;
  recencyXa90: number | null;
  recencyMinutes: number;
  // Season yellow count for suspension penalty (5/10/15 thresholds).
  seasonYellows: number;
  // Opposition attacking style 0..1 — used to scale expected defensive
  // actions. Possession-dominant opponents = more chances to act.
  oppAttackingStyle: number;
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
  // CRITICAL: strip the penalty contribution from xG inputs BEFORE shrinking,
  // because the pen component is added separately later. Without this, pen
  // takers get their pen xG counted twice:
  //   1. inside `currentXg90` / `baselineXg90` (which derive from total xG)
  //   2. via `playerExpectedPenGoals` added below
  //
  // Estimated pen xG per 90:
  //   penalty_share × (5 pens / season ÷ 38 matches) × 0.78 (conversion)
  // ≈ penalty_share × 0.103 per 90.
  // We subtract this from xG before shrinking so the shrunk value reflects
  // open-play threat only. The pen-derived component is then added in §2.
  const PENS_PER_90 = 5 / 38;
  const penXg90 = ctx.penaltyShare * PENS_PER_90 * 0.78;
  const adjustedBaselineXg90 = Math.max(0, ctx.baselineXg90 - penXg90);

  // §model-sharpening: prefer the recency-weighted per-90 over the flat
  // current-season average. Same logic for xA. We still shrink toward the
  // long-term baseline using the EFFECTIVE sample size (recency-weighted
  // minutes), so a player with only 2 recent starts doesn't override their
  // long-term baseline based on those 2 games.
  //
  // PENALTY ADJUSTMENT is applied to BOTH recency and current values so
  // we never feed pen-inflated xG into the shrinker.
  const recencyXg90Adj = ctx.recencyXg90 != null
    ? Math.max(0, ctx.recencyXg90 - penXg90) : null;
  const recencyXa90 = ctx.recencyXa90;
  const currentXg90Adj = ctx.currentXg90 != null
    ? Math.max(0, ctx.currentXg90 - penXg90) : null;

  // Effective sample for shrinkage: recency-weighted minutes when we have
  // them, else flat season minutes. Recency-weighted minutes ARE smaller
  // numerically (older games down-weighted) — that's intentional, it means
  // the shrinker correctly demands recent evidence to override the baseline.
  const effectiveSampleN = ctx.recencyMinutes > 0 ? ctx.recencyMinutes : minutesSeen;
  const xg90Input = recencyXg90Adj ?? currentXg90Adj ?? adjustedBaselineXg90;
  const xa90Input = recencyXa90    ?? ctx.currentXa90 ?? ctx.baselineXa90;
  const xg90 = shrink(xg90Input, effectiveSampleN, adjustedBaselineXg90, priorN);
  const xa90 = shrink(xa90Input, effectiveSampleN, ctx.baselineXa90,     priorN);

  if (penXg90 > 0) {
    reasons.push({
      kind: 'open_play_xg_only',
      weight: penXg90,
      detail: `stripped ${penXg90.toFixed(2)} pen xG/90 from baseline (pen share ${(ctx.penaltyShare*100).toFixed(0)}%); pen goals added separately`
    });
  }
  if (recencyXg90Adj != null && currentXg90Adj != null &&
      Math.abs(recencyXg90Adj - currentXg90Adj) > 0.05) {
    reasons.push({
      kind: 'recency_weighted_form',
      weight: recencyXg90Adj - currentXg90Adj,
      detail: `recency-weighted xG/90 ${recencyXg90Adj.toFixed(2)} vs flat ${currentXg90Adj.toFixed(2)} — ${recencyXg90Adj > currentXg90Adj ? 'trending UP' : 'trending DOWN'}`
    });
  }
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
    // §model-sharpening — opposition-aware DEFCON, tightened.
    //
    // Defensive actions scale with how much the OPPONENT attacks. After
    // the Bayesian team rating recompute, `attacking_style` is a
    // multiplier around 1.0 (was 0..1 in the heuristic days), so the
    // old `clamp01(0.5 + 0.6 × style) × 1.4` formula saturated at 1.4
    // for almost every opponent — turning a sub-threshold player into
    // an above-threshold one purely from the opp adjustment. New
    // formula: opp multiplier ∈ [0.85, 1.15] centred on 1.0. A 15%
    // boost for the most attacking side, 15% cut for the most defensive.
    // Real-world: tackles/interceptions vary by team but ±15% captures
    // it; the bigger driver is the PLAYER's per-90 rate.
    const styleDelta = (ctx.oppAttackingStyle ?? 1.0) - 1.0;   // -0.4 .. +1.0 after Bayesian
    const oppMultiplier = Math.max(0.85, Math.min(1.15, 1.0 + 0.15 * styleDelta));
    const baseExpectedActions = ctx.defconPer90 * (ctx.expectedMinutes / 90);
    const expectedActions = baseExpectedActions * oppMultiplier;

    // P(Poisson(lambda) >= k) — sum 0..k-1 for the CDF.
    const lambda = expectedActions;
    let cdf = 0;
    let term = Math.exp(-lambda);
    for (let i = 0; i < defconThreshold; i++) {
      cdf += term;
      term = term * lambda / (i + 1);
    }
    let pDefconRaw = Math.max(0, 1 - cdf);

    // §model-sharpening — strong over-dispersion correction for the
    // SUB-THRESHOLD case. Defensive-action counts are bursty (a player
    // might log 4 in one match and 14 in the next). When the per-90
    // average is below the threshold, the Poisson tail OVERESTIMATES
    // P(X ≥ threshold) because it ignores the wider variance — a
    // Negative Binomial would be more honest. As a cheap proxy, scale
    // the tail probability by how close baseExpected is to the
    // threshold. If baseExpected ≥ threshold the player genuinely
    // averages above, so no penalty. If baseExpected < threshold by
    // more than 1.5, the empirical hit rate is much lower than Poisson
    // suggests — we apply up to a 0.5× discount.
    const gap = defconThreshold - baseExpectedActions; // positive when sub-threshold
    let dispersionDiscount = 1.0;
    if (gap > 0) {
      // gap=0   → 1.00
      // gap=1.5 → 0.75
      // gap=3   → 0.50  (floor)
      dispersionDiscount = Math.max(0.5, 1.0 - 0.17 * gap);
    } else {
      // Even above-threshold players have variance; keep the previous
      // 12% conservative haircut so we don't overstate confidence.
      dispersionDiscount = 0.88;
    }
    const pDefcon = Math.max(0, Math.min(1, pDefconRaw * dispersionDiscount));

    xpts_defcon = pDefcon * 2 * ctx.sixtyPlusProb;
    if (xpts_defcon > 0.05) {
      reasons.push({
        kind: 'defcon',
        weight: xpts_defcon,
        detail:
          `${baseExpectedActions.toFixed(1)} actions/match (per-90 ${ctx.defconPer90.toFixed(1)}) ` +
          `× ${oppMultiplier.toFixed(2)} opp = ${expectedActions.toFixed(1)} expected. ` +
          `Threshold ${defconThreshold}: Poisson tail ${(pDefconRaw*100).toFixed(0)}% × dispersion ${dispersionDiscount.toFixed(2)} ` +
          `= P(≥${defconThreshold}) ${(pDefcon*100).toFixed(0)}%`
      });
    }
  }

  // §model-sharpening — yellow-card suspension penalty.
  // FPL rule: 5 yellows triggers a 1-game ban; 10 triggers 2; 15 triggers 3.
  // If a player is 1 yellow short of a threshold AND has shown a high
  // yellow rate, they're at meaningful risk of missing the next match.
  // We dock half the expected appearance + base points pro-rata to that
  // probability. Conservative because thresholds reset after each
  // suspension and we don't track exact discipline reset history.
  const NEXT_YELLOW_THRESHOLDS = [5, 10, 15];
  const cardsToNextThreshold = NEXT_YELLOW_THRESHOLDS
    .map(t => t - ctx.seasonYellows)
    .filter(g => g > 0 && g <= 1)
    .pop();
  let suspensionPenalty = 0;
  if (cardsToNextThreshold === 1 && ctx.baselineYellow90 > 0.2) {
    // Probability of picking up a yellow this match ≈ baseline yellow/90
    // × P(plays 60+). Conservative.
    const pYellow = clamp01(ctx.baselineYellow90 * ctx.sixtyPlusProb);
    // Cost of missing the NEXT match ≈ 2/3 of a typical projection (5 pts).
    suspensionPenalty = pYellow * 3.3;
    if (suspensionPenalty > 0.1) {
      reasons.push({
        kind: 'suspension_risk',
        weight: -suspensionPenalty,
        detail: `${ctx.seasonYellows} yellows so far — 1 short of suspension; P(yellow this match) ${(pYellow*100).toFixed(0)}%`
      });
    }
  }

  // Total — suspension risk is a NEGATIVE contribution (expected lost points
  // from missing the next match). Subtracted from the headline xpts so the
  // user sees the risk-adjusted value, not the raw "if-he-plays" number.
  const xpts_total =
    xpts_appearance + xpts_goals + xpts_assists + xpts_clean_sheet +
    xpts_bonus + xpts_saves + xpts_pen_save + xpts_cards + xpts_concede +
    xpts_owngoal + xpts_defcon - suspensionPenalty;

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
 *
 * §walk-forward options:
 *   - `includeFinished` — also predict finished fixtures (default false in
 *     live mode, true for backtest harnesses that need historic snapshots).
 *   - `cutoffGameweek` — when set, the historic-data layers (team ratings,
 *     player aggregates) will be re-derived using only data from GWs
 *     strictly before this cutoff. Required for fair walk-forward; without
 *     it, predictions leak future information. NOTE: full cutoff threading
 *     is in progress (see WALK-FORWARD-PLAN.md). Today, only team-rating
 *     accepts the cutoff.
 */
export async function recomputeProjectionsForGameweek(
  gameweekId: number,
  options?: { includeFinished?: boolean; cutoffGameweek?: number }
) {
  const stage = classifyStage(gameweekId);
  const weights = weightsForStage(stage);
  const includeFinished = options?.includeFinished ?? false;

  // §calibration — load per-position multipliers ONCE and apply at projection
  // write-time. The model_calibration table is populated by train:engine from
  // the full-season backtest. Without this step the multiplier was only ever
  // applied at one UI surface (/gw) and never persisted, so the planner /
  // captaincy / xray all showed uncalibrated raw numbers — which is what
  // caused the visible -0.33 season-bias.
  const calibrationByPos = new Map<string, { multiplier: number; confidence: number }>();
  try {
    const calRows = await sql<Array<{
      position: string; multiplier: number; confidence: number;
    }>>`SELECT position, multiplier::float8, confidence::float8 FROM model_calibration`;
    for (const r of calRows) {
      calibrationByPos.set(r.position, {
        multiplier: Number(r.multiplier),
        confidence: Number(r.confidence)
      });
    }
  } catch {/* table may not exist before migration 0010 applied */}

  const fixtures = includeFinished
    ? await sql<Array<{ id: number; team_h: number; team_a: number }>>`
        SELECT id, team_h, team_a FROM fixtures
        WHERE gameweek_id = ${gameweekId}
      `
    : await sql<Array<{ id: number; team_h: number; team_a: number }>>`
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
      // Recency-weighted form (exponential decay, half-life ~3 GW). Heavier
      // weight on the player's most recent matches — beats the flat
      // season-sum which treats GW1 the same as last week.
      recency_minutes: number; recency_xg: number; recency_xa: number; recency_yellow: number;
      season_xg: number; season_xa: number; season_bonus: number;
      season_defcon_per_90: number;
      season_yellows: number;
      xg_open_play_understat: number | null;
      xg_penalty_understat: number | null;
      xg_set_piece_understat: number | null;
      shots_open_play: number | null;
      shots_penalty: number | null;
      shots_set_piece: number | null;
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
        COALESCE(y.season_yellows, 0)::int                                       AS season_yellows,
        -- §shot-data — Understat per-situation xG. Falls back to NULL when
        -- the player has no Understat row (new signings; off-season ingest
        -- not yet run). The engine handles NULL by reverting to the
        -- season_xg pen-share heuristic.
        psa.xg_open_play::numeric                                                AS xg_open_play_understat,
        psa.xg_penalty::numeric                                                  AS xg_penalty_understat,
        psa.xg_set_piece::numeric                                                AS xg_set_piece_understat,
        psa.shots_open_play::int                                                 AS shots_open_play,
        psa.shots_penalty::int                                                   AS shots_penalty,
        psa.shots_set_piece::int                                                 AS shots_set_piece,
        COALESCE(recency.minutes, 0)::numeric AS recency_minutes,
        COALESCE(recency.xg, 0)::numeric      AS recency_xg,
        COALESCE(recency.xa, 0)::numeric      AS recency_xa,
        COALESCE(recency.yellow, 0)::numeric  AS recency_yellow,
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
          SUM(bonus)::numeric AS bonus,
          SUM(yellow_cards)::int AS yellow_cards
        FROM player_gameweek_history WHERE player_id = p.id
      ) c ON TRUE
      -- §shot-data — pull Understat per-situation xG aggregates. Used by
      -- the engine downstream to compute TRUE open-play xG without the
      -- season_xg pen-inflation heuristic.
      LEFT JOIN player_shot_aggregates psa ON psa.player_id = p.id
      LEFT JOIN LATERAL (
        -- Recency-weighted xG / xA / minutes via exponential decay. The
        -- decay factor 0.80 has a half-life of ~3 GW so a player's
        -- last 5 starts dominate; a goal scored in GW1 carries ~5% the
        -- weight of one scored in GW37. We use the gameweek_id gap
        -- against the planning gameweek as the exponent.
        SELECT
          SUM(pgh.minutes        * POWER(0.80, GREATEST(0, ${gameweekId}::int - pgh.gameweek_id)))::numeric AS minutes,
          SUM(pgh.expected_goals * POWER(0.80, GREATEST(0, ${gameweekId}::int - pgh.gameweek_id)))::numeric AS xg,
          SUM(pgh.expected_assists * POWER(0.80, GREATEST(0, ${gameweekId}::int - pgh.gameweek_id)))::numeric AS xa,
          SUM(pgh.yellow_cards * POWER(0.80, GREATEST(0, ${gameweekId}::int - pgh.gameweek_id)))::numeric AS yellow
          FROM player_gameweek_history pgh
         WHERE pgh.player_id = p.id
      ) recency ON TRUE,
      LATERAL (
        SELECT COALESCE((c.yellow_cards)::int, 0) AS season_yellows
      ) y
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
      //
      // §sample-size threshold (Le Fée bug fix):
      //   FPL's penalties_order field is a snapshot — a player listed as #2
      //   may only have taken 1 actual penalty all season. Crediting them
      //   with 30% pen share over-inflates their xG by ~0.25 EV.
      //   We cross-check against Understat shots_penalty:
      //     - #1 taker with ≥3 actual pen attempts → full 0.95 share
      //     - #1 taker with <3 attempts → degrade to 0.50 (still primary, less certainty)
      //     - #2 taker with ≥5 attempts → full 0.30 share
      //     - #2 taker with <5 attempts → degrade to 0.10 (slight upside only)
      //   This stops "designated #2 takers" from inflating projections off
      //   tiny samples while preserving the signal for genuine pen takers.
      const manualPenShare = playerOv.find(o => o.kind === 'penalty_taker')?.value?.share;
      const actualPenShots = Number(p.shots_penalty) || 0;
      const rawPenShare =
        p.penalties_order === 1 ? 0.95 :
        p.penalties_order === 2 ? 0.30 : 0;
      const penShareAfterSample =
        p.penalties_order === 1 && actualPenShots < 3 ? Math.min(rawPenShare, 0.50) :
        p.penalties_order === 2 && actualPenShots < 5 ? Math.min(rawPenShare, 0.10) :
        rawPenShare;
      const penaltyShare =
        manualPenShare != null ? manualPenShare : penShareAfterSample;

      // §sample-size threshold for set pieces too — same rationale. Corner/FK
      // takers need observed evidence. Understat's `shots_set_piece` covers
      // direct FKs only (corner-takers don't shoot from corners, so it's a
      // weaker proxy but still better than the bare order field).
      const actualSetPieceShots = Number(p.shots_set_piece) || 0;
      const rawCornerShare =
        p.corners_order === 1 ? 0.9 : p.corners_order === 2 ? 0.4 : 0;
      const rawFkShare =
        p.freekicks_order === 1 ? 0.9 : p.freekicks_order === 2 ? 0.4 : 0;
      const fkAfterSample =
        p.freekicks_order === 1 && actualSetPieceShots < 2 ? Math.min(rawFkShare, 0.35) :
        p.freekicks_order === 2 && actualSetPieceShots < 4 ? Math.min(rawFkShare, 0.15) :
        rawFkShare;
      const manualSpShare = playerOv.find(o => o.kind === 'set_piece')?.value?.share;
      const setPieceShare =
        manualSpShare != null ? manualSpShare :
        Math.max(rawCornerShare, fkAfterSample);

      // goal- and assist-share — derived from data so a 35%-of-team-xG striker
      // isn't treated like a fringe forward. We clamp the share to 60% so the
      // model never collapses to "Haaland gets everything"; the rest is shared
      // with the other 10 outfielders implicitly.
      //
      // §shot-data — when Understat aggregates exist for the player, use the
      // TRUE per-situation xG split (open_play vs penalty vs set_piece) instead
      // of the season_xg pen-share heuristic. The heuristic was ~5 pens/season
      // × 0.78; the actual number is in xg_penalty_understat with zero noise.
      // For players without Understat data we fall back to the heuristic.
      const hasUnderstat = (p as any).xg_open_play_understat != null;
      const playerOpenPlayXg = hasUnderstat
        ? Number((p as any).xg_open_play_understat) || 0
        : Math.max(0, Number(p.season_xg) - penaltyShare * 5 * 0.78);
      // Team open-play xG: still heuristic-derived for now (a future
      // iteration will pull team_shot_aggregates for the exact number).
      const teamOpenPlayXg = Math.max(0, Number(p.team_xg_total) - 3.9);
      const goalShare   = teamOpenPlayXg > 0
        ? Math.min(0.60, playerOpenPlayXg / teamOpenPlayXg)
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

      // Recency-weighted per-90 from the decayed history sums.
      const recencyMinutes = Number(p.recency_minutes) || 0;
      const recencyXg90 = recencyMinutes > 0
        ? (Number(p.recency_xg) * 90) / recencyMinutes : null;
      const recencyXa90 = recencyMinutes > 0
        ? (Number(p.recency_xa) * 90) / recencyMinutes : null;

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
        newSigningPenalty, managerChangePenalty,
        // §model-sharpening inputs
        recencyXg90, recencyXa90, recencyMinutes,
        seasonYellows: Number(p.season_yellows) || 0,
        oppAttackingStyle: opp.attacking
      });

      // §calibration apply — multiply each xPts component by the per-position
      // confidence-weighted multiplier. Components scale linearly with the
      // overall multiplier so the EV decomposition bar still shows the right
      // proportions. xpts_appearance is intentionally NOT scaled — appearance
      // points are deterministic (you played, you got them) so calibrating
      // them would inflate the floor incorrectly.
      const cal = calibrationByPos.get(p.position);
      const mult = cal
        ? (1 - cal.confidence) * 1.0 + cal.confidence * cal.multiplier
        : 1.0;
      // We scale the "skill-driven" components but leave appearance alone.
      // Cards/concede/owngoal/pen_save are tiny negative tweaks; we scale
      // them so the relative balance stays right.
      const scale = (x: number) => Number(x) * mult;
      const calibratedReasons = [
        ...projection.reasons,
        {
          kind: 'calibration',
          weight: 0,
          detail: `position multiplier ${mult.toFixed(2)}× (model_calibration[${p.position}], confidence ${cal ? (cal.confidence*100).toFixed(0) : '0'}%)`
        }
      ];

      // xpts_total stays internally consistent: sum of components.
      const calibratedTotal =
        projection.xpts_appearance      // unscaled — appearance is deterministic
        + scale(projection.xpts_goals)
        + scale(projection.xpts_assists)
        + scale(projection.xpts_clean_sheet)
        + scale(projection.xpts_bonus)
        + scale(projection.xpts_saves)
        + scale(projection.xpts_pen_save)
        + scale(projection.xpts_cards)
        + scale(projection.xpts_concede)
        + scale(projection.xpts_owngoal)
        + scale(projection.xpts_defcon);

      projRows.push({
        player_id: p.id, fixture_id: fix.id, gameweek_id: gameweekId,
        xpts_total: calibratedTotal,
        xpts_appearance: projection.xpts_appearance,
        xpts_goals: scale(projection.xpts_goals),
        xpts_assists: scale(projection.xpts_assists),
        xpts_clean_sheet: scale(projection.xpts_clean_sheet),
        xpts_bonus: scale(projection.xpts_bonus),
        xpts_saves: scale(projection.xpts_saves),
        xpts_pen_save: scale(projection.xpts_pen_save),
        xpts_cards: scale(projection.xpts_cards),
        xpts_concede: scale(projection.xpts_concede),
        xpts_owngoal: scale(projection.xpts_owngoal),
        xpts_defcon: scale(projection.xpts_defcon),
        // Floor/ceiling — scale the variable portion (total - appearance) and
        // re-add appearance so the structural minimum (just showing up) is
        // preserved.
        floor:   projection.xpts_appearance + scale(projection.floor   - projection.xpts_appearance),
        ceiling: projection.xpts_appearance + scale(projection.ceiling - projection.xpts_appearance),
        risk_score: projection.risk_score,
        confidence_score: projection.confidence_score,
        reasons: calibratedReasons,
        computed_at: new Date()
      });
      snapshotRows.push({
        gameweek_id: gameweekId,
        player_id: p.id, fixture_id: fix.id,
        // Snapshot the CALIBRATED payload so RMSE measurement sees the
        // values the user actually got, not the pre-calibration raw.
        payload: { ...projection, xpts_total: calibratedTotal, calibration_multiplier: mult },
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
