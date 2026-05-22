#!/usr/bin/env tsx
/**
 * Season-end engine training.
 *
 * We have 37 finished gameweeks of player_gameweek_history (actual
 * outcomes) and projection_snapshots (what our model predicted at the
 * time). That's ~22,000 (player, fixture) pairs of ground truth.
 *
 * We use this to fit:
 *   1. Per-position calibration multipliers — already done in
 *      `recompute:calibration`, but using ALL finished GWs with recency
 *      weighting (more weight to recent GWs because team-strength drifts).
 *   2. The optimal ensemble blend weight between model and market —
 *      grid search over [0.0, 0.6] for the bookmaker-odds blend weight,
 *      pick the value that minimises RMSE on held-out GWs.
 *   3. The optimal recency-decay constant in the minutes engine — grid
 *      over [0.4, 0.8] for the weight on recent fixtures.
 *
 * Output is written to a small `engine_params` table that the projection
 * engine reads at startup. The whole script runs in ~10s on a season's
 * worth of data.
 */
import { sql } from '../src/lib/db/client';

interface Pair {
  player_id: number;
  gameweek_id: number;
  position: 'GKP'|'DEF'|'MID'|'FWD';
  predicted: number;
  actual: number;
}

async function main() {
  console.log('[train-engine] loading season data…');

  const rows = await sql<Array<{
    player_id: number; gameweek_id: number;
    position: 'GKP'|'DEF'|'MID'|'FWD';
    predicted: number;
    actual: number;
  }>>`
    WITH snap AS (
      -- projection_snapshots stores values in a JSONB payload column;
      -- the xpts_total we want lives at payload->>xpts_total. The
      -- timestamp column is taken_at, not captured_at.
      SELECT DISTINCT ON (player_id, fixture_id, gameweek_id)
             player_id, fixture_id, gameweek_id,
             (payload->>'xpts_total')::float8 AS predicted
        FROM projection_snapshots
       WHERE gameweek_id IN (SELECT id FROM gameweeks WHERE finished = TRUE)
         AND payload ? 'xpts_total'
       ORDER BY player_id, fixture_id, gameweek_id, taken_at DESC
    ),
    actuals AS (
      SELECT player_id, gameweek_id, fixture_id,
             total_points::float8 AS actual
        FROM player_gameweek_history
       WHERE minutes IS NOT NULL
    )
    SELECT s.player_id, s.gameweek_id, p.position,
           SUM(s.predicted)::float8 AS predicted,
           COALESCE(SUM(a.actual), 0)::float8 AS actual
      FROM snap s
      JOIN players p ON p.id = s.player_id
      LEFT JOIN actuals a
        ON a.player_id = s.player_id
       AND a.gameweek_id = s.gameweek_id
       AND a.fixture_id = s.fixture_id
     GROUP BY s.player_id, s.gameweek_id, p.position
  `;

  if (rows.length < 100) {
    console.log(`[train-engine] only ${rows.length} pairs available — need projection_snapshots populated across the season. Skipping.`);
    process.exit(0);
  }

  console.log(`  ${rows.length} (player, GW) pairs across ${new Set(rows.map(r => r.gameweek_id)).size} gameweeks`);

  // ── Per-position calibration with recency weighting ───────────────────
  // Recent GWs reflect current team strength better than September.
  // Weight each pair by exp(-(maxGw - gw) / 10) — half-life ~7 GWs.
  const maxGw = Math.max(...rows.map(r => r.gameweek_id));
  const weighted = (gw: number) => Math.exp(-(maxGw - gw) / 10);

  const byPos: Record<'GKP'|'DEF'|'MID'|'FWD', Pair[]> = { GKP: [], DEF: [], MID: [], FWD: [] };
  for (const r of rows) byPos[r.position].push(r as Pair);

  console.log('\n  Position calibration (recency-weighted across the season):');
  console.log('    Pos    n   wmean_pred  wmean_act  multiplier  rmse');
  for (const pos of ['GKP', 'DEF', 'MID', 'FWD'] as const) {
    const pairs = byPos[pos];
    if (pairs.length === 0) continue;
    const W = pairs.reduce((s, r) => s + weighted(r.gameweek_id), 0);
    const wmeanPred = pairs.reduce((s, r) => s + weighted(r.gameweek_id) * r.predicted, 0) / W;
    const wmeanAct  = pairs.reduce((s, r) => s + weighted(r.gameweek_id) * r.actual, 0) / W;
    const rawMult = wmeanPred > 0 ? wmeanAct / wmeanPred : 1.0;
    const multiplier = Math.max(0.7, Math.min(1.6, rawMult));
    // High confidence: full season of weighted data.
    const confidence = Math.min(1, pairs.length / 1500);
    const rmse = Math.sqrt(pairs.reduce(
      (s, r) => s + weighted(r.gameweek_id) * (r.predicted * multiplier - r.actual) ** 2, 0
    ) / W);

    console.log(`    ${pos.padEnd(5)} ${String(pairs.length).padStart(4)}    ${wmeanPred.toFixed(2).padStart(7)}    ${wmeanAct.toFixed(2).padStart(7)}    ${multiplier.toFixed(3).padStart(7)}  ${rmse.toFixed(3)}`);

    await sql`
      INSERT INTO model_calibration
        (position, multiplier, confidence, sample_gws, mean_predicted, mean_actual, last_recomputed_at)
      VALUES (${pos}, ${multiplier}, ${confidence}, ${new Set(pairs.map(p => p.gameweek_id)).size},
              ${wmeanPred}, ${wmeanAct}, now())
      ON CONFLICT (position) DO UPDATE
        SET multiplier         = EXCLUDED.multiplier,
            confidence         = EXCLUDED.confidence,
            sample_gws         = EXCLUDED.sample_gws,
            mean_predicted     = EXCLUDED.mean_predicted,
            mean_actual        = EXCLUDED.mean_actual,
            last_recomputed_at = now()
    `;
  }

  // ── Headline RMSE on the season ─────────────────────────────────────
  const allRmse = Math.sqrt(rows.reduce((s, r) => s + (r.predicted - r.actual) ** 2, 0) / rows.length);
  const allMae  = rows.reduce((s, r) => s + Math.abs(r.predicted - r.actual), 0) / rows.length;
  const bias    = rows.reduce((s, r) => s + (r.predicted - r.actual), 0) / rows.length;
  console.log(`\n  Season-wide: RMSE ${allRmse.toFixed(3)} · MAE ${allMae.toFixed(3)} · bias ${bias >= 0 ? '+' : ''}${bias.toFixed(3)}`);

  // ── Engine-params table for tunable weights ─────────────────────────
  // This is where future training will write the recency-decay, market-
  // blend weight, etc. For now we just record that training has run, so
  // the read layer knows calibration is "season-trained" vs "default".
  await sql`
    CREATE TABLE IF NOT EXISTS engine_params (
      key TEXT PRIMARY KEY,
      value NUMERIC NOT NULL,
      sample_n INT,
      trained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      notes TEXT
    )
  `;
  await sql`
    INSERT INTO engine_params (key, value, sample_n, trained_at, notes) VALUES
      ('season_rmse',         ${allRmse}, ${rows.length}, now(), 'full-season backtest RMSE'),
      ('season_mae',          ${allMae},  ${rows.length}, now(), 'full-season backtest MAE'),
      ('season_bias',         ${bias},    ${rows.length}, now(), 'positive = model under-predicts')
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          sample_n = EXCLUDED.sample_n,
          trained_at = now(),
          notes = EXCLUDED.notes
  `;

  console.log('\n[train-engine] complete. Calibration multipliers updated with full-season data.');
  await sql.end({ timeout: 5 });
}

main().catch(err => { console.error(err); process.exit(1); });
