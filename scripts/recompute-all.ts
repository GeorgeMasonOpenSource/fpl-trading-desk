/**
 * Full FPLReview-grade recompute pipeline.
 *
 * Runs in this order:
 *   1. Recompute Bayesian team ratings from observed xG (writes
 *      teams.attacking_style + teams.defensive_solidity).
 *   2. Recompute hierarchical per-90 estimates with empirical-Bayes
 *      shrinkage (writes player_hierarchical_estimates).
 *   3. Re-run the projection engine for the target gameweek, which now
 *      picks up:
 *        - Understat per-shot open-play xG (via player_shot_aggregates)
 *        - Bayesian team attack/defence multipliers
 *        - Hierarchical shrunk per-90s (when present)
 *   4. (Optional) Run Monte Carlo on every fixture for the target GW.
 *      Outputs floor/ceiling/haulProb to projection_distributions table.
 *
 * Designed to be cheap enough to re-run hourly as new info lands. Each
 * stage is independent — if step 2 fails we still publish step 1's
 * output.
 *
 * Usage:
 *   tsx scripts/recompute-all.ts                 # current GW
 *   tsx scripts/recompute-all.ts --gw 38         # specific GW
 *   tsx scripts/recompute-all.ts --gw 38 --mc    # include monte carlo
 */

import { sql } from '../src/lib/db/client';
import { recomputeTeamRatings, ratingFixtureXg } from '../src/lib/projections/team-rating';
import { recomputeHierarchicalEstimates } from '../src/lib/projections/hierarchical';
import { recomputeProjectionsForGameweek } from '../src/lib/projections/engine';
import { simulateFixture } from '../src/lib/projections/monte-carlo';
import { recomputePerPositionDefence } from '../src/lib/projections/per-position-defence';
import { recomputeMinutesCalibration } from '../src/lib/minutes/per-position-calibration';
import { recomputeSetPieceRoles } from '../src/lib/projections/set-piece-roles';
import { recomputeMinutesForGameweek } from '../src/lib/minutes/engine';

async function main() {
  const args = process.argv.slice(2);
  const gwArg = args.indexOf('--gw');
  const targetGw = gwArg >= 0 ? Number(args[gwArg + 1]) : await currentGw();
  const runMc = args.includes('--mc');
  console.log(`[recompute-all] target gameweek: ${targetGw}`);

  // 1. Team ratings -----------------------------------------------------
  const t0 = Date.now();
  console.log('[recompute-all] step 1/4 — Bayesian team ratings');
  await recomputeTeamRatings();
  console.log(`[recompute-all] step 1 done in ${Date.now() - t0}ms`);

  // 1b. Per-position defensive ratings — the structural improvement
  // FPLReview doesn't have. Decomposes single defensive_solidity into
  // per-(team, opponent_position) multipliers from observed xG-conceded.
  // Cheap (single SQL pass). Run after 1.
  const t0b = Date.now();
  console.log('[recompute-all] step 1b — per-position defensive ratings');
  try {
    await recomputePerPositionDefence();
    console.log(`[recompute-all] step 1b done in ${Date.now() - t0b}ms`);
  } catch (err) {
    console.warn(`[recompute-all] step 1b SKIPPED (${(err as Error).message}) — apply migration 0011 to enable`);
  }

  // 1c. Minutes calibration — per-position multiplier from snapshot-vs-actuals.
  const t0c = Date.now();
  console.log('[recompute-all] step 1c — minutes calibration');
  try {
    await recomputeMinutesCalibration();
    console.log(`[recompute-all] step 1c done in ${Date.now() - t0c}ms`);
  } catch (err) {
    console.warn(`[recompute-all] step 1c SKIPPED (${(err as Error).message})`);
  }

  // 1d. Set-piece roles — derive pen / DFK / corner takers from shot data.
  const t0d = Date.now();
  console.log('[recompute-all] step 1d — set-piece role tracking');
  try {
    await recomputeSetPieceRoles();
    console.log(`[recompute-all] step 1d done in ${Date.now() - t0d}ms`);
  } catch (err) {
    console.warn(`[recompute-all] step 1d SKIPPED (${(err as Error).message})`);
  }

  // 2. Hierarchical estimates -------------------------------------------
  const t1 = Date.now();
  console.log('[recompute-all] step 2/4 — hierarchical per-90 estimates');
  const hier = await recomputeHierarchicalEstimates();
  console.log(`[recompute-all] step 2 done in ${Date.now() - t1}ms (${hier.length} players)`);

  // Persist hierarchical output. Table created on first run.
  await sql`
    CREATE TABLE IF NOT EXISTS player_hierarchical_estimates (
      player_id     INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      position      TEXT NOT NULL,
      xg90          NUMERIC NOT NULL,
      xa90          NUMERIC NOT NULL,
      bonus90       NUMERIC NOT NULL,
      own_weight    NUMERIC NOT NULL,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  for (const h of hier) {
    await sql`
      INSERT INTO player_hierarchical_estimates
        (player_id, position, xg90, xa90, bonus90, own_weight)
      VALUES (${h.playerId}, ${h.position}, ${h.xg90}, ${h.xa90}, ${h.bonus90}, ${h.ownWeight})
      ON CONFLICT (player_id) DO UPDATE
        SET xg90 = EXCLUDED.xg90,
            xa90 = EXCLUDED.xa90,
            bonus90 = EXCLUDED.bonus90,
            own_weight = EXCLUDED.own_weight,
            updated_at = now()
    `;
  }

  // 2b. Minutes engine — writes minutes_projections rows that the
  // projection engine reads in step 3. Without this step, rotation_risk
  // and expected_minutes are stale (from the last db:seed). Must run
  // BEFORE the projection engine.
  const t2a = Date.now();
  console.log('[recompute-all] step 2b — minutes engine');
  try {
    const minutesRows = await recomputeMinutesForGameweek(targetGw);
    console.log(`[recompute-all] step 2b done in ${Date.now() - t2a}ms (${minutesRows} fixtures processed)`);
  } catch (err) {
    console.warn(`[recompute-all] step 2b FAILED: ${(err as Error).message}`);
  }

  // 3. Projection engine ------------------------------------------------
  const t2 = Date.now();
  console.log('[recompute-all] step 3/4 — projection engine');
  await recomputeProjectionsForGameweek(targetGw);
  console.log(`[recompute-all] step 3 done in ${Date.now() - t2}ms`);

  // 4. Monte Carlo (opt-in) ---------------------------------------------
  if (runMc) {
    const t3 = Date.now();
    console.log('[recompute-all] step 4/4 — monte carlo per fixture');
    await runMonteCarloForGameweek(targetGw);
    console.log(`[recompute-all] step 4 done in ${Date.now() - t3}ms`);
  } else {
    console.log('[recompute-all] step 4 skipped (pass --mc to include)');
  }

  console.log('[recompute-all] all stages complete');
  await sql.end({ timeout: 5 });
  process.exit(0);
}

async function currentGw(): Promise<number> {
  const rows = await sql<Array<{ id: number }>>`
    SELECT id FROM gameweeks
     WHERE is_next = true OR is_current = true
     ORDER BY id ASC
     LIMIT 1
  `;
  if (rows.length === 0) throw new Error('No current/next gameweek found');
  return rows[0]!.id;
}

async function runMonteCarloForGameweek(gameweekId: number) {
  // Pull the gameweek's fixtures and the relevant 22-player rosters.
  const fixtures = await sql<Array<{
    id: number; team_h: number; team_a: number;
  }>>`SELECT id, team_h, team_a FROM fixtures WHERE gameweek_id = ${gameweekId}`;
  await sql`
    CREATE TABLE IF NOT EXISTS projection_distributions (
      player_id     INTEGER NOT NULL,
      gameweek_id   INTEGER NOT NULL,
      fixture_id    INTEGER NOT NULL,
      mean          NUMERIC NOT NULL,
      median        NUMERIC NOT NULL,
      floor_p10     NUMERIC NOT NULL,
      ceiling_p90   NUMERIC NOT NULL,
      haul_prob     NUMERIC NOT NULL,
      blank_prob    NUMERIC NOT NULL,
      iterations    INTEGER NOT NULL,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (player_id, gameweek_id, fixture_id)
    )
  `;
  for (const f of fixtures) {
    const rated = await ratingFixtureXg(f.id);
    if (!rated) continue;
    // Pull the 11-ish likely starters per side (top by season minutes).
    const homePlayers = await sql<Array<{
      id: number; position: 'GKP'|'DEF'|'MID'|'FWD';
      shot_share: number | null; mean_xg_per_shot: number | null;
      assist_share: number | null; minutes_per_app: number | null;
      bonus_per_90: number | null;
    }>>`
      SELECT p.id, p.position,
             -- shot share = open-play shots / team total open-play shots.
             -- Approximated: own shots / 250 (typical PL team season shots).
             COALESCE(psa.shots_open_play::float8 / 250.0, 0)    AS shot_share,
             -- xG per shot = total open-play xG / shots, fallback 0.10.
             CASE WHEN psa.shots_open_play > 0
                  THEN (psa.xg_open_play::float8 / psa.shots_open_play)
                  ELSE 0.10
             END                                                  AS mean_xg_per_shot,
             -- Assist share: approximate from season_xa as % of team xA.
             COALESCE(p.season_xa::float8 / 30.0, 0)::float8     AS assist_share,
             -- Minutes per app: season_minutes / max(1, starts).
             CASE WHEN p.season_starts > 0
                  THEN p.season_minutes::float8 / p.season_starts
                  ELSE 75.0
             END                                                  AS minutes_per_app,
             -- Bonus per 90: season_bonus × 90 / minutes.
             CASE WHEN p.season_minutes > 0
                  THEN (p.season_bonus::float8 * 90) / p.season_minutes
                  ELSE 0.3
             END                                                  AS bonus_per_90
        FROM players p
        LEFT JOIN player_shot_aggregates psa ON psa.player_id = p.id
       WHERE p.team_id = ${f.team_h} AND p.status <> 'u'
       ORDER BY COALESCE(p.season_minutes, 0) DESC
       LIMIT 14
    `;
    const awayPlayers = await sql<Array<{
      id: number; position: 'GKP'|'DEF'|'MID'|'FWD';
      shot_share: number | null; mean_xg_per_shot: number | null;
      assist_share: number | null; minutes_per_app: number | null;
      bonus_per_90: number | null;
    }>>`
      SELECT p.id, p.position,
             -- shot share = open-play shots / team total open-play shots.
             -- Approximated: own shots / 250 (typical PL team season shots).
             COALESCE(psa.shots_open_play::float8 / 250.0, 0)    AS shot_share,
             -- xG per shot = total open-play xG / shots, fallback 0.10.
             CASE WHEN psa.shots_open_play > 0
                  THEN (psa.xg_open_play::float8 / psa.shots_open_play)
                  ELSE 0.10
             END                                                  AS mean_xg_per_shot,
             -- Assist share: approximate from season_xa as % of team xA.
             COALESCE(p.season_xa::float8 / 30.0, 0)::float8     AS assist_share,
             -- Minutes per app: season_minutes / max(1, starts).
             CASE WHEN p.season_starts > 0
                  THEN p.season_minutes::float8 / p.season_starts
                  ELSE 75.0
             END                                                  AS minutes_per_app,
             -- Bonus per 90: season_bonus × 90 / minutes.
             CASE WHEN p.season_minutes > 0
                  THEN (p.season_bonus::float8 * 90) / p.season_minutes
                  ELSE 0.3
             END                                                  AS bonus_per_90
        FROM players p
        LEFT JOIN player_shot_aggregates psa ON psa.player_id = p.id
       WHERE p.team_id = ${f.team_a} AND p.status <> 'u'
       ORDER BY COALESCE(p.season_minutes, 0) DESC
       LIMIT 14
    `;

    const toMcInput = (p: typeof homePlayers[number]) => ({
      playerId: p.id,
      position: p.position,
      shotShareOpenPlay: Number(p.shot_share) || 0,
      meanXgPerShot: Number(p.mean_xg_per_shot) || 0.10,
      assistShare: Number(p.assist_share) || 0,
      expectedMinutes: Number(p.minutes_per_app) || 75,
      bonusPer90: Number(p.bonus_per_90) || 0.5,
      cleanSheetShare: 1
    });

    const out = simulateFixture({
      homeXgMean: rated.homeXg,
      awayXgMean: rated.awayXg,
      homeShotsMean: 13,
      awayShotsMean: 13,
      homePlayers: homePlayers.map(toMcInput),
      awayPlayers: awayPlayers.map(toMcInput),
      iterations: 10000
    });

    for (const o of out) {
      await sql`
        INSERT INTO projection_distributions
          (player_id, gameweek_id, fixture_id,
           mean, median, floor_p10, ceiling_p90, haul_prob, blank_prob, iterations)
        VALUES
          (${o.playerId}, ${gameweekId}, ${f.id},
           ${o.mean}, ${o.median}, ${o.floor}, ${o.ceiling},
           ${o.haulProb}, ${o.blankProb}, 10000)
        ON CONFLICT (player_id, gameweek_id, fixture_id) DO UPDATE
          SET mean = EXCLUDED.mean,
              median = EXCLUDED.median,
              floor_p10 = EXCLUDED.floor_p10,
              ceiling_p90 = EXCLUDED.ceiling_p90,
              haul_prob = EXCLUDED.haul_prob,
              blank_prob = EXCLUDED.blank_prob,
              iterations = EXCLUDED.iterations,
              updated_at = now()
      `;
    }
    console.log(`[recompute-all]   fixture ${f.id}: ${out.length} players simulated`);
  }
}

main().catch(err => {
  console.error('[recompute-all] FATAL', err);
  process.exit(1);
});
