import { sql } from '@/lib/db/client';

/**
 * Bayesian team strength rating.
 *
 * Replaces the static `teams.season_xg_total` with a rolling rating that
 * updates after every observed match. Each team has a 2-D state:
 *
 *   attack  — multiplier on league-average xG for. >1 = better than avg.
 *   defence — multiplier on league-average xG against. <1 = better than avg.
 *
 * After each match, we observe xG_for and xG_against and apply a Kalman-
 * style update toward the observation, with a gain that depends on how
 * much new evidence we have vs how much we trust the prior.
 *
 *   gain = sigma_obs² / (sigma_prior² + sigma_obs²)
 *   state_new = state_prior + gain × (observation - state_prior)
 *
 * Simpler than a full Kalman because we don't model state-transition
 * noise — we assume team strength evolves slowly enough that the prior
 * is a reasonable estimate of next-match strength.
 *
 * Used downstream to derive `team_xg_for` / `team_xg_against` for the
 * upcoming fixture as:
 *
 *   team_xg_for     = league_xg_per_match × attack × opponent.defence
 *   team_xg_against = league_xg_per_match × defence × opponent.attack
 *
 * This is the same structural form used by Dixon-Coles and the standard
 * Bayesian football models in academic literature.
 */

export interface TeamRating {
  teamId: number;
  attack: number;        // multiplier on league mean xG for
  defence: number;       // multiplier on league mean xG against
  observations: number;  // number of matches contributing
  uncertainty: number;   // 0..1, lower = more confident
}

// Tuning constants. SIGMA_OBS reflects per-match xG noise (1 match of xG
// data is fairly noisy). SIGMA_PRIOR_INIT starts wide so early-season
// data dominates quickly. After ~10 games per team, the rating stabilises.
const SIGMA_OBS_2 = 0.6 * 0.6;       // 0.6 xG-stdev per match
const SIGMA_PRIOR_2_INIT = 0.4 * 0.4; // wide prior initially
const LEAGUE_XG_PER_MATCH_DEFAULT = 1.4;

/**
 * Recompute ratings for all teams from the team_shot_aggregates table.
 * Called after each Understat ingest. Output is persisted on
 * teams.attacking_style + teams.defensive_solidity (which the engine
 * already reads), keeping the data flow clean.
 *
 * §walk-forward: pass `cutoffGameweek` to fit using only data from
 * fixtures BEFORE that GW. Used by the season backtest harness to
 * measure RMSE per GW without data leakage. When null (default), uses
 * the full season — matches the live production behaviour.
 */
export async function recomputeTeamRatings(cutoffGameweek?: number): Promise<void> {
  // For walk-forward we re-derive team xg_for + xg_against from
  // `player_shot_history` filtered by match date < the deadline for
  // `cutoffGameweek`. The flat `team_shot_aggregates` table is a
  // current-state snapshot and can't be GW-filtered, so we bypass it
  // when a cutoff is set.
  let cutoffDate: string | null = null;
  if (cutoffGameweek != null) {
    const dl = await sql<Array<{ deadline_time: Date | null }>>`
      SELECT deadline_time FROM gameweeks WHERE id = ${cutoffGameweek}
    `;
    cutoffDate = dl[0]?.deadline_time
      ? (dl[0].deadline_time as any).toISOString()
      : null;
  }

  const rows = cutoffDate
    // Cutoff-aware: derive xg_for + xg_against entirely from shot history
    // filtered by match_date < cutoff. No reliance on the flat aggregate
    // table (which reflects the END of the season, not the cutoff).
    ? await sql<Array<{
        team_id: number; matches: number; xg_for: number; xg_against: number;
      }>>`
        WITH shots AS (
          SELECT p.team_id, psh.fixture_id, psh.match_date, psh.xg::float8 AS xg
            FROM player_shot_history psh
            JOIN players p ON p.id = psh.player_id
           WHERE psh.match_date < ${cutoffDate}
        ),
        fx AS (
          SELECT DISTINCT team_id, fixture_id, match_date FROM shots
        )
        SELECT t.id AS team_id,
               COALESCE((
                 SELECT COUNT(DISTINCT fixture_id)::int
                   FROM fx WHERE fx.team_id = t.id
               ), 0) AS matches,
               COALESCE((
                 SELECT SUM(xg)::numeric FROM shots WHERE shots.team_id = t.id
               ), 0) AS xg_for,
               COALESCE((
                 SELECT SUM(xg)::numeric FROM shots
                  WHERE shots.fixture_id IN (
                    SELECT fixture_id FROM fx WHERE fx.team_id = t.id
                  )
                    AND shots.team_id != t.id
               ), 0) AS xg_against
          FROM teams t
      `
    : await sql<Array<{
        team_id: number; matches: number; xg_for: number; xg_against: number;
      }>>`
        SELECT t.id AS team_id,
               COALESCE(tsa.matches_team_xg, tsa.matches, 0)::int AS matches,
               -- §unbiased team xG — prefer Understat's team-level totals
               -- (no player-mapping dependency, so includes shots from
               -- every player). Fall back to the leaky per-player sum
               -- only if the team-level ingest hasn't populated tsa.xg_for.
               COALESCE(
                 tsa.xg_for::numeric,
                 (SELECT SUM(xg)
                    FROM player_shot_history psh
                    JOIN players p ON p.id = psh.player_id
                   WHERE p.team_id = t.id),
                 0
               ) AS xg_for,
               COALESCE(tsa.xg_against::numeric, 0) AS xg_against
          FROM teams t
          LEFT JOIN team_shot_aggregates tsa ON tsa.team_id = t.id
      `;

  // League average xG per match — used as the unit baseline.
  const totalMatches = rows.reduce((s, r) => s + Number(r.matches), 0);
  const totalXgFor = rows.reduce((s, r) => s + Number(r.xg_for), 0);
  const leagueXgPerMatch = totalMatches > 0
    ? totalXgFor / totalMatches
    : LEAGUE_XG_PER_MATCH_DEFAULT;

  const updates: Array<{ teamId: number; attack: number; defence: number }> = [];
  for (const r of rows) {
    const matches = Math.max(1, Number(r.matches));
    const observedFor = Number(r.xg_for) / matches;       // per-match xG for
    const observedAgainst = Number(r.xg_against) / matches;
    // Multipliers vs league mean. Clamped to [0.4, 2.0] — extreme values
    // are almost always small-sample artefacts.
    const obsAttack  = clamp(observedFor / leagueXgPerMatch, 0.4, 2.0);
    const obsDefence = clamp(observedAgainst / leagueXgPerMatch, 0.4, 2.0);
    // §kalman — proper Bayesian update.
    //
    // CORRECTED MATH: as we observe more matches, our uncertainty about
    // the observed mean SHRINKS (sigma_obs² / n). The prior's uncertainty
    // stays fixed at SIGMA_PRIOR_2_INIT — that's how much we believed in
    // "team = league average" BEFORE seeing data. After N matches, the
    // gain should tend to 1 (trust the observation).
    //
    // Old (buggy) math:
    //   sigmaPrior2 = SIGMA_PRIOR_2_INIT / matches    ← shrunk wrong term
    //   gain = sigmaPrior2 / (sigmaPrior2 + SIGMA_OBS_2)
    //   → gain → 0 as matches → ∞  (model trusts the prior more with more data!)
    //
    // New (correct) math:
    //   sigmaPrior2 = SIGMA_PRIOR_2_INIT                 (fixed prior uncertainty)
    //   sigmaObsMean2 = SIGMA_OBS_2 / matches            (sample-mean variance)
    //   gain = sigmaPrior2 / (sigmaPrior2 + sigmaObsMean2)
    //   → gain → 1 as matches → ∞  (model trusts the data with more samples)
    //
    // For matches = 38, SIGMA_PRIOR_2_INIT = 0.16, SIGMA_OBS_2 = 0.36:
    //   sigmaObsMean2 = 0.36/38 = 0.0095
    //   gain = 0.16 / (0.16 + 0.0095) = 0.944
    // So a 38-game season gives the observation ~94% weight — correct.
    // For matches = 3 (start of season):
    //   sigmaObsMean2 = 0.36/3 = 0.12
    //   gain = 0.16 / (0.16 + 0.12) = 0.571
    // So 3 games gives the obs ~57% weight — sensible early-season shrinkage.
    const sigmaPrior2 = SIGMA_PRIOR_2_INIT;
    const sigmaObsMean2 = SIGMA_OBS_2 / Math.max(1, matches);
    const gain = sigmaPrior2 / (sigmaPrior2 + sigmaObsMean2);
    const priorAttack  = 1.0;          // start each team at league average
    const priorDefence = 1.0;
    const attack  = priorAttack  + gain * (obsAttack  - priorAttack);
    const defence = priorDefence + gain * (obsDefence - priorDefence);
    updates.push({ teamId: r.team_id, attack, defence });
  }

  // Persist to teams.attacking_style + teams.defensive_solidity. These
  // columns already exist and are read by the engine — we just give them
  // proper Bayesian values rather than the earlier heuristic.
  for (const u of updates) {
    await sql`
      UPDATE teams
         SET attacking_style    = ${Number(u.attack.toFixed(3))},
             defensive_solidity = ${Number((1 / Math.max(0.1, u.defence)).toFixed(3))}
       WHERE id = ${u.teamId}
    `;
  }
}

/**
 * For a given fixture, compute the expected per-team xG using the
 * structural attack × opponent defence form.
 *
 *   homeXg = league × home.attack × away.defence × HOME_FIELD_BONUS
 *   awayXg = league × away.attack × home.defence
 */
export async function ratingFixtureXg(
  fixtureId: number,
  homeFieldBonus = 1.15
): Promise<{ homeXg: number; awayXg: number } | null> {
  const rows = await sql<Array<{
    team_h: number; team_a: number;
    h_attack: number; h_defence: number;
    a_attack: number; a_defence: number;
  }>>`
    SELECT f.team_h, f.team_a,
           th.attacking_style::float8    AS h_attack,
           th.defensive_solidity::float8 AS h_defence,
           ta.attacking_style::float8    AS a_attack,
           ta.defensive_solidity::float8 AS a_defence
      FROM fixtures f
      JOIN teams th ON th.id = f.team_h
      JOIN teams ta ON ta.id = f.team_a
     WHERE f.id = ${fixtureId}
  `;
  if (rows.length === 0) return null;
  const r = rows[0]!;
  // defensive_solidity is 1/defence (higher = better defence), so we
  // invert when using as an opponent-defence multiplier.
  const homeDefenceMult = 1 / Math.max(0.1, r.h_defence);
  const awayDefenceMult = 1 / Math.max(0.1, r.a_defence);
  const homeXg = LEAGUE_XG_PER_MATCH_DEFAULT * r.h_attack * awayDefenceMult * homeFieldBonus;
  const awayXg = LEAGUE_XG_PER_MATCH_DEFAULT * r.a_attack * homeDefenceMult;
  return { homeXg, awayXg };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
