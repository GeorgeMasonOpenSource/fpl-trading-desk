import { sql } from '@/lib/db/client';
import { clamp01, logistic } from '@/lib/util/math';
import { computeReliability, computeRotationResistance } from './reliability';
import type { ProjectionReason } from '@/lib/db/types';

/**
 * Minutes Engine.
 *
 * For every (player, future fixture) pair, produce a *distribution* over the
 * possible minutes outcomes:
 *
 *   - injury_absence : flagged out, didn't play
 *   - bench_unused   : in squad, didn't come on
 *   - sub            : came on as substitute (1..59 minutes typically)
 *   - sixty_plus     : played 60-89 minutes
 *   - ninety         : played 90+ minutes
 *
 * The expected-points layer must consume the whole distribution, not just
 * expected minutes. A 0.80 chance of 90 + 0.20 chance of 0 is very different
 * from a 1.00 chance of 72.
 *
 * Inputs are deterministic and observable. Nothing here is ML.
 */

export interface MinutesInputs {
  playerId: number;
  fixtureId: number;
  // From player_baselines + recent observation:
  reliability: number;              // 0..1 historical availability + congestion resilience
  rotationResistance: number;       // 0..1 — how little congestion penalty applies
  currentSeasonStartRate: number;   // 0..1 from this season's lineup observations
  currentSeasonNinetyRate: number;  // 0..1
  currentSeasonAppearanceRate: number;
  fplStatus: 'a' | 'd' | 'i' | 'n' | 's' | 'u';
  chanceOfPlayingNext: number | null; // 0..100 from FPL
  // Context for this specific fixture:
  isPostEuropeanFixture: boolean;
  isPreEuropeanFixture: boolean;
  daysRestBefore: number | null;
  daysRestAfter: number | null;
  fixtureImportance: number;        // 0..2 — late season title race etc.
  // Depth-chart signal: number of stronger alternatives currently available
  // (computed from current season role evidence).
  competitorPressure: number;       // 0..1
  // Injury return path: 1 = first match back, 2 = second, ... null = not returning
  returnFromInjuryMatch: number | null;
  // Manual overrides (already coalesced):
  manualMinutesCap?: number;        // hard cap minutes (e.g. "60 max on return")
  manualExpectedAbsence?: boolean;
}

export interface MinutesDistribution {
  startProb: number;
  sixtyPlusProb: number;
  ninetyProb: number;
  subProb: number;
  benchUnusedProb: number;
  injuryAbsenceProb: number;
  expectedMinutes: number;
  earlySubRisk: number;
  rotationRisk: number;
  rotationResistance: number;
  reliability: number;
  confidence: number;
  reasons: ProjectionReason[];
}

export function projectMinutes(input: MinutesInputs): MinutesDistribution {
  const reasons: ProjectionReason[] = [];

  // 1. Injury / availability gate ---------------------------------------------
  let injuryAbsenceProb = 0;
  if (input.manualExpectedAbsence) {
    injuryAbsenceProb = 0.95;
    reasons.push({ kind: 'manual_absence_override', weight: 0.95, detail: 'manual override: expected absence' });
  } else {
    switch (input.fplStatus) {
      case 'a': injuryAbsenceProb = 0.02; break;            // available
      case 'd': {                                             // doubtful — use chance of playing
        const chance = input.chanceOfPlayingNext == null ? 50 : input.chanceOfPlayingNext;
        injuryAbsenceProb = clamp01(1 - chance / 100);
        reasons.push({ kind: 'doubt_flag', weight: injuryAbsenceProb, detail: `chance of playing: ${chance}%` });
        break;
      }
      case 'i': injuryAbsenceProb = 0.92; break;            // injured
      case 'n': injuryAbsenceProb = 0.90; break;            // ineligible / not in squad
      case 's': injuryAbsenceProb = 0.97; break;            // suspended
      case 'u': injuryAbsenceProb = 0.90; break;            // unavailable
    }
  }

  // 2. Start probability (given available) -----------------------------------
  // Start with current-season start rate, blend with reliability.
  // Reliability acts as a stabiliser for thin samples.
  let startGivenAvailable =
    0.70 * input.currentSeasonStartRate +
    0.30 * input.reliability;

  // Competitor pressure penalises the start prob.
  startGivenAvailable -= 0.25 * input.competitorPressure;
  if (input.competitorPressure > 0.1) {
    reasons.push({ kind: 'competitor_pressure', weight: input.competitorPressure, detail: `${(input.competitorPressure*100).toFixed(0)}% squad pressure` });
  }

  // Rotation penalty for European fixtures — scaled DOWN by rotation resistance.
  // Highly resistant players (a Bruno-type profile or a nailed CB) see a tiny
  // dent; a rotation-prone winger sees a big dent.
  let rotationPenalty = 0;
  if (input.isPostEuropeanFixture) {
    const base = 0.18;
    const scaled = base * (1 - input.rotationResistance);
    rotationPenalty += scaled;
    reasons.push({ kind: 'post_european', weight: scaled, detail: `post-European fixture rotation penalty (resistance ${(input.rotationResistance*100).toFixed(0)}%)` });
  }
  if (input.isPreEuropeanFixture) {
    const base = 0.10;
    const scaled = base * (1 - input.rotationResistance);
    rotationPenalty += scaled;
    reasons.push({ kind: 'pre_european', weight: scaled, detail: `pre-European fixture rotation penalty` });
  }
  if (input.daysRestBefore != null && input.daysRestBefore <= 3) {
    const fatiguePenalty = (4 - input.daysRestBefore) * 0.05 * (1 - input.rotationResistance);
    rotationPenalty += fatiguePenalty;
    reasons.push({ kind: 'fixture_congestion', weight: fatiguePenalty, detail: `${input.daysRestBefore} days rest` });
  }
  // Late season / important fixtures: rotation actually DECREASES.
  if (input.fixtureImportance > 1.2) {
    rotationPenalty -= 0.05;
    reasons.push({ kind: 'fixture_importance', weight: 0.05, detail: 'important match — less rotation' });
  }

  startGivenAvailable -= rotationPenalty;

  // Returning from injury: cap start prob aggressively in match 1, partial in match 2.
  if (input.returnFromInjuryMatch === 1) {
    startGivenAvailable = Math.min(startGivenAvailable, 0.45);
    reasons.push({ kind: 'return_match_1', weight: 0.4, detail: 'first match back — minutes cap likely' });
  } else if (input.returnFromInjuryMatch === 2) {
    startGivenAvailable = Math.min(startGivenAvailable, 0.70);
    reasons.push({ kind: 'return_match_2', weight: 0.2, detail: 'second match back — partial cap' });
  }

  startGivenAvailable = clamp01(startGivenAvailable);

  const startProb = clamp01(startGivenAvailable * (1 - injuryAbsenceProb));

  // 3. Once starting: distribution over how many minutes ----------------------
  // 90-min rate, conditional on starting.
  const ninetyGivenStart = clamp01(
    0.70 * input.currentSeasonNinetyRate +
    0.30 * input.reliability -
    (input.returnFromInjuryMatch === 1 ? 0.6 : 0) -
    (input.returnFromInjuryMatch === 2 ? 0.3 : 0)
  );
  const sixtyToEightyNineGivenStart = clamp01(1 - ninetyGivenStart - 0.05);
  // tiny residual: "started but went off before 60"
  const startedButEarlyOff = clamp01(1 - ninetyGivenStart - sixtyToEightyNineGivenStart);

  // 4. Sub appearances (given not starting & available) ----------------------
  const subGivenNotStartingAvail = clamp01(
    0.6 * input.currentSeasonAppearanceRate -
    0.4 * (input.currentSeasonStartRate)
  );

  // 5. Compose distribution ---------------------------------------------------
  const availableNotStarting = (1 - injuryAbsenceProb) - startProb;
  const subProb = clamp01(availableNotStarting * subGivenNotStartingAvail);
  const benchUnusedProb = clamp01(availableNotStarting - subProb);
  const ninetyProb = clamp01(startProb * ninetyGivenStart);
  const sixtyPlusProb = clamp01(startProb * sixtyToEightyNineGivenStart + ninetyProb);
  const earlySubRisk = clamp01(startProb * startedButEarlyOff);

  // 6. Expected minutes -------------------------------------------------------
  // Honour any manual cap (e.g. "manager said 60 max").
  const cap = input.manualMinutesCap ?? 90;
  const expectedMinutes =
    ninetyProb * Math.min(90, cap) +
    (startProb - ninetyProb) * Math.min(75, cap) +    // 60-89 starters average ~75
    earlySubRisk * Math.min(35, cap) +
    subProb * Math.min(20, cap) +
    benchUnusedProb * 0 +
    injuryAbsenceProb * 0;

  // 7. Confidence -------------------------------------------------------------
  // Higher current-season sample + higher reliability => higher confidence.
  const confidence = clamp01(
    0.5 * input.reliability +
    0.3 * Math.min(1, input.currentSeasonAppearanceRate * 1.5) +
    0.2 * (input.manualMinutesCap ? 0.4 : 1.0)        // manual cap means uncertainty
  );

  return {
    startProb,
    sixtyPlusProb,
    ninetyProb,
    subProb,
    benchUnusedProb,
    injuryAbsenceProb,
    expectedMinutes,
    earlySubRisk,
    rotationRisk: clamp01(rotationPenalty + input.competitorPressure * 0.5),
    rotationResistance: input.rotationResistance,
    reliability: input.reliability,
    confidence,
    reasons
  };
}

/**
 * Run the engine for every upcoming fixture in the given gameweek and persist
 * the distribution.
 *
 * Batched implementation: 4 SELECTs + 1 bulk INSERT regardless of player count.
 *   1. SELECT fixtures + their kickoff times
 *   2. SELECT all (player, team, status) for the teams involved
 *   3. SELECT all player history aggregates in one query
 *   4. SELECT all manual overrides for those players
 *   (european_fixtures filtered in JS — typically a handful of rows total)
 *   5. Compute distribution per (player, fixture) in JS
 *   6. Bulk INSERT all rows in one round-trip
 */
export async function recomputeMinutesForGameweek(gw: number) {
  const fixtures = await sql<Array<{
    id: number; team_h: number; team_a: number; kickoff_time: string | null;
  }>>`
    SELECT id, team_h, team_a, kickoff_time
    FROM fixtures
    WHERE gameweek_id = ${gw} AND finished = FALSE
  `;
  if (fixtures.length === 0) return 0;

  const teamIds = Array.from(new Set(fixtures.flatMap(f => [f.team_h, f.team_a])));
  if (teamIds.length === 0) return 0;

  // All players on either side, with their status flags.
  const players = await sql<Array<{
    id: number; team_id: number; status: 'a'|'d'|'i'|'n'|'s'|'u';
    chance_of_playing_next_round: number | null;
  }>>`
    SELECT id, team_id, status, chance_of_playing_next_round
    FROM players WHERE team_id IN ${sql(teamIds as any)}
  `;
  const playerIds = players.map(p => p.id);

  // Career aggregates per player — single query.
  const aggs = playerIds.length === 0 ? [] : await sql<Array<{
    player_id: number; appearances: number; starts: number; ninety: number;
    eligible: number; congestion_starts: number; congestion_eligible: number;
    early_off: number;
  }>>`
    SELECT
      pgh.player_id,
      COUNT(*) FILTER (WHERE pgh.minutes > 0)::int       AS appearances,
      COUNT(*) FILTER (WHERE pgh.starts = 1)::int        AS starts,
      COUNT(*) FILTER (WHERE pgh.minutes >= 90)::int     AS ninety,
      COUNT(*)::int                                      AS eligible,
      COUNT(*) FILTER (WHERE pgh.starts = 1 AND f.kickoff_time IS NOT NULL)::int AS congestion_starts,
      COUNT(*) FILTER (WHERE TRUE)::int                  AS congestion_eligible,
      COUNT(*) FILTER (WHERE pgh.minutes BETWEEN 1 AND 59)::int AS early_off
    FROM player_gameweek_history pgh
    LEFT JOIN fixtures f ON f.id = pgh.fixture_id
    WHERE pgh.player_id IN ${sql(playerIds as any)}
    GROUP BY pgh.player_id
  `;
  const aggByPlayer = new Map(aggs.map(a => [a.player_id, a]));

  // Manual overrides for these players — single query.
  const overrides = playerIds.length === 0 ? [] : await sql<Array<{
    scope_id: number; kind: string; value: any;
  }>>`
    SELECT scope_id, kind, value FROM manual_overrides
    WHERE scope = 'player' AND active = TRUE
      AND scope_id IN ${sql(playerIds as any)}
      AND (expires_at IS NULL OR expires_at > now())
  `;
  const overridesByPlayer = new Map<number, Array<{ kind: string; value: any }>>();
  for (const o of overrides) {
    if (!overridesByPlayer.has(o.scope_id)) overridesByPlayer.set(o.scope_id, []);
    overridesByPlayer.get(o.scope_id)!.push({ kind: o.kind, value: o.value });
  }

  // European fixtures within the GW window — small table, one query.
  const euFixtures = teamIds.length === 0 ? [] : await sql<Array<{
    team_id: number; kickoff_time: string;
  }>>`
    SELECT team_id, kickoff_time FROM european_fixtures
    WHERE team_id IN ${sql(teamIds as any)}
  `;

  const rows: any[] = [];
  for (const fix of fixtures) {
    const kickoff = fix.kickoff_time ? new Date(fix.kickoff_time).getTime() : null;
    const fixturePlayers = players.filter(p => p.team_id === fix.team_h || p.team_id === fix.team_a);

    for (const p of fixturePlayers) {
      const agg = aggByPlayer.get(p.id);
      const reliabilityInput = {
        appearancesAvailable: agg?.appearances ?? 0,
        totalAvailable:       agg?.eligible ?? 0,
        startsAvailable:      agg?.starts ?? 0,
        ninetyMinutesPlayed:  agg?.ninety ?? 0,
        earlySubOffCount:     agg?.early_off ?? 0,
        congestionStarts:     agg?.congestion_starts ?? 0,
        congestionEligible:   agg?.congestion_eligible ?? 0
      };
      const reliability = computeReliability(reliabilityInput);
      const rotationResistance = computeRotationResistance(reliabilityInput);

      // EU context — compute against the in-memory list.
      let postEu = false, preEu = false;
      if (kickoff != null) {
        for (const e of euFixtures) {
          if (e.team_id !== p.team_id) continue;
          const ekt = new Date(e.kickoff_time).getTime();
          const deltaDays = Math.abs(kickoff - ekt) / (1000 * 60 * 60 * 24);
          if (deltaDays > 4) continue;
          if (ekt < kickoff) postEu = true; else preEu = true;
        }
      }

      const playerOv = overridesByPlayer.get(p.id) ?? [];
      const manualCap = playerOv.find(o => o.kind === 'minutes_cap')?.value?.cap as number | undefined;
      const manualAbsence = playerOv.some(o => o.kind === 'availability' && o.value?.expected === 'out');

      const startRate     = agg && agg.eligible ? agg.starts / agg.eligible : 0;
      const ninetyRate    = agg && agg.starts ? agg.ninety / agg.starts : 0;
      const appearanceRate = agg && agg.eligible ? agg.appearances / agg.eligible : 0;

      const distribution = projectMinutes({
        playerId: p.id, fixtureId: fix.id,
        reliability, rotationResistance,
        currentSeasonStartRate: startRate,
        currentSeasonNinetyRate: ninetyRate,
        currentSeasonAppearanceRate: appearanceRate,
        fplStatus: p.status,
        chanceOfPlayingNext: p.chance_of_playing_next_round,
        isPostEuropeanFixture: postEu,
        isPreEuropeanFixture:  preEu,
        daysRestBefore: null, daysRestAfter: null,
        fixtureImportance: 1.0,
        competitorPressure: 0,
        returnFromInjuryMatch: null,
        manualMinutesCap: manualCap,
        manualExpectedAbsence: manualAbsence
      });

      rows.push({
        player_id: p.id,
        fixture_id: fix.id,
        start_prob: distribution.startProb,
        sixty_plus_prob: distribution.sixtyPlusProb,
        ninety_prob: distribution.ninetyProb,
        sub_prob: distribution.subProb,
        bench_unused_prob: distribution.benchUnusedProb,
        injury_absence_prob: distribution.injuryAbsenceProb,
        expected_minutes: distribution.expectedMinutes,
        early_sub_risk: distribution.earlySubRisk,
        rotation_risk: distribution.rotationRisk,
        rotation_resistance: distribution.rotationResistance,
        minutes_confidence: distribution.confidence,
        reliability_index: distribution.reliability,
        reasons: JSON.stringify(distribution.reasons),
        computed_at: new Date()
      });
    }
  }

  if (rows.length === 0) return fixtures.length;
  await sql`
    INSERT INTO minutes_projections ${(sql as any)(rows,
      'player_id', 'fixture_id', 'start_prob', 'sixty_plus_prob', 'ninety_prob',
      'sub_prob', 'bench_unused_prob', 'injury_absence_prob', 'expected_minutes',
      'early_sub_risk', 'rotation_risk', 'rotation_resistance', 'minutes_confidence',
      'reliability_index', 'reasons', 'computed_at')}
    ON CONFLICT (player_id, fixture_id) DO UPDATE SET
      start_prob = EXCLUDED.start_prob,
      sixty_plus_prob = EXCLUDED.sixty_plus_prob,
      ninety_prob = EXCLUDED.ninety_prob,
      sub_prob = EXCLUDED.sub_prob,
      bench_unused_prob = EXCLUDED.bench_unused_prob,
      injury_absence_prob = EXCLUDED.injury_absence_prob,
      expected_minutes = EXCLUDED.expected_minutes,
      early_sub_risk = EXCLUDED.early_sub_risk,
      rotation_risk = EXCLUDED.rotation_risk,
      rotation_resistance = EXCLUDED.rotation_resistance,
      minutes_confidence = EXCLUDED.minutes_confidence,
      reliability_index = EXCLUDED.reliability_index,
      reasons = EXCLUDED.reasons,
      computed_at = now()
  `;
  return fixtures.length;
}
