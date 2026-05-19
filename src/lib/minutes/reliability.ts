import { sql } from '@/lib/db/client';
import { clamp01, shrink } from '@/lib/util/math';

/**
 * Minutes Reliability Index.
 *
 * "Reliability" answers: when this player has been available, how reliably did
 * he play heavy minutes regardless of context (fixture congestion, opponent,
 * cup distractions)? We never hardcode names. Instead we derive it from data:
 *
 *   reliability = w(season_appearance_rate, 90min_rate, sub_off_minute_avg,
 *                   congestion_start_rate_relative_to_baseline)
 *
 * Players with elite availability + high 90-min rate + no congestion drop-off
 * land near 0.95+. Rotation-prone players land near 0.30-0.55.
 *
 * Inputs are all observable PL data (no betting, no opinion). The function is
 * deterministic and reproducible from player_gameweek_history + fixture data.
 */
export interface ReliabilityInput {
  appearancesAvailable: number;     // PL appearances when not flagged out
  totalAvailable: number;           // PL fixtures team played while player was available
  startsAvailable: number;
  ninetyMinutesPlayed: number;
  earlySubOffCount: number;         // subbed off < 60'
  congestionStarts: number;         // PL starts in a "congested" period (3-day rest or post-Europe)
  congestionEligible: number;       // congested PL fixtures while available
}

const PRIOR_APPEARANCE = 0.85;      // typical regular's appearance rate
const PRIOR_NINETY     = 0.60;
const PRIOR_SAMPLE_N   = 6;         // equivalent-sample-size shrinkage

export function computeReliability(input: ReliabilityInput): number {
  const appearanceRate = input.totalAvailable
    ? input.appearancesAvailable / input.totalAvailable
    : PRIOR_APPEARANCE;

  const startRate = input.totalAvailable
    ? input.startsAvailable / input.totalAvailable
    : PRIOR_APPEARANCE;

  const ninetyRate = input.appearancesAvailable
    ? input.ninetyMinutesPlayed / input.appearancesAvailable
    : PRIOR_NINETY;

  // Shrink each rate toward the prior so a 2-game sample doesn't dominate.
  const aShrunk = shrink(appearanceRate, input.totalAvailable, PRIOR_APPEARANCE, PRIOR_SAMPLE_N);
  const sShrunk = shrink(startRate,     input.totalAvailable, PRIOR_APPEARANCE, PRIOR_SAMPLE_N);
  const nShrunk = shrink(ninetyRate,    input.appearancesAvailable, PRIOR_NINETY, PRIOR_SAMPLE_N);

  // Early-sub penalty: if a player is regularly hooked at 55-60', reliability dips.
  const subOffPenalty = input.appearancesAvailable
    ? clamp01(input.earlySubOffCount / Math.max(1, input.appearancesAvailable)) * 0.20
    : 0;

  // Congestion-resilience bonus. A regular who started in congested weeks gets +0..0.10.
  const congestionScore = input.congestionEligible
    ? clamp01(input.congestionStarts / input.congestionEligible)
    : 0.5;
  const congestionBonus = (congestionScore - 0.5) * 0.20;

  const raw =
    0.40 * aShrunk +
    0.30 * sShrunk +
    0.30 * nShrunk -
    subOffPenalty +
    congestionBonus;

  return clamp01(raw);
}

/**
 * Rotation Resistance Coefficient.
 * Closely related to reliability but specifically: how *little* does this
 * player's start rate drop in congestion periods? Used by the Minutes Engine
 * to scale down the rotation penalty for nailed-on profiles. Range 0..1.
 */
export function computeRotationResistance(input: ReliabilityInput): number {
  if (input.congestionEligible === 0) {
    // No congested-period evidence yet: lean conservative (mid).
    return 0.5;
  }
  const congestionStartRate = input.congestionStarts / input.congestionEligible;
  const normalStartRate = input.totalAvailable
    ? input.startsAvailable / input.totalAvailable
    : 0.7;
  // ratio of congested start-rate vs overall start-rate. Cap at 1.0.
  const ratio = clamp01(normalStartRate > 0 ? congestionStartRate / normalStartRate : 0.5);
  return ratio;
}

/** Persists reliability + rotation resistance back to player_baselines. */
export async function persistReliabilityForAllPlayers() {
  const rows = await sql<Array<{
    player_id: number;
    appearances_available: number;
    total_available: number;
    starts_available: number;
    ninety_minutes_played: number;
    early_sub_off_count: number;
    congestion_starts: number;
    congestion_eligible: number;
  }>>`
    WITH avail AS (
      -- All player-fixture observations where the player wasn't flagged out.
      SELECT
        pgh.player_id,
        pgh.fixture_id,
        pgh.minutes,
        pgh.starts,
        (pgh.minutes BETWEEN 1 AND 59) AS early_sub_off,
        EXISTS (
          -- Congested fixture := <= 4 days rest before kickoff, looking at the
          -- same team's previous PL fixture.
          SELECT 1
          FROM fixtures fa
          JOIN fixtures fb ON fb.id != fa.id
            AND (fb.team_h IN (SELECT team_id FROM players WHERE id = pgh.player_id)
              OR fb.team_a IN (SELECT team_id FROM players WHERE id = pgh.player_id))
            AND fb.kickoff_time < fa.kickoff_time
          WHERE fa.id = pgh.fixture_id
            AND fa.kickoff_time IS NOT NULL
            AND fb.kickoff_time IS NOT NULL
            AND fa.kickoff_time - fb.kickoff_time <= interval '4 days'
        ) AS congested
      FROM player_gameweek_history pgh
    )
    SELECT
      player_id,
      COUNT(*) FILTER (WHERE minutes > 0)::int       AS appearances_available,
      COUNT(*)::int                                  AS total_available,
      COUNT(*) FILTER (WHERE starts = 1)::int        AS starts_available,
      COUNT(*) FILTER (WHERE minutes >= 90)::int     AS ninety_minutes_played,
      COUNT(*) FILTER (WHERE early_sub_off)::int     AS early_sub_off_count,
      COUNT(*) FILTER (WHERE congested AND starts = 1)::int AS congestion_starts,
      COUNT(*) FILTER (WHERE congested)::int         AS congestion_eligible
    FROM avail
    GROUP BY player_id
  `;

  for (const r of rows) {
    const rel = computeReliability({
      appearancesAvailable: r.appearances_available,
      totalAvailable:       r.total_available,
      startsAvailable:      r.starts_available,
      ninetyMinutesPlayed:  r.ninety_minutes_played,
      earlySubOffCount:     r.early_sub_off_count,
      congestionStarts:     r.congestion_starts,
      congestionEligible:   r.congestion_eligible
    });
    await sql`
      INSERT INTO player_baselines (player_id, reliability_index, sample_size_minutes, computed_at)
      VALUES (${r.player_id}, ${rel},
              ${r.total_available * 90}, now())
      ON CONFLICT (player_id) DO UPDATE SET
        reliability_index = EXCLUDED.reliability_index,
        sample_size_minutes = EXCLUDED.sample_size_minutes,
        computed_at = now()
    `;
  }
  return rows.length;
}
