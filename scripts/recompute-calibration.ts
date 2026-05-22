#!/usr/bin/env tsx
/**
 * Recompute per-position calibration multipliers from finished gameweeks.
 *
 * For each position, computes:
 *   multiplier = mean_actual / mean_predicted
 *
 * Where:
 *   - mean_predicted is the avg xpts_total from projection_snapshots
 *     across all finished GWs we have snapshots for, summed per
 *     (player, fixture)
 *   - mean_actual is the avg total_points across the same set of
 *     (player, fixture) pairs in player_gameweek_history
 *
 * Confidence scales with the number of (player, fixture) samples:
 *   confidence = min(1, samples / 300)
 *
 * The projection-display layer applies the multiplier weighted by
 * confidence: corrected = raw × ((1 - conf) × 1.0 + conf × multiplier).
 * So with 0 samples → no correction; with 300+ samples → full correction.
 *
 *   npm run recompute:calibration
 *
 * Run weekly after the last GW finishes. Idempotent.
 */
import { sql } from '../src/lib/db/client';

async function main() {
  console.log('[recompute-calibration] computing per-position multipliers…');

  const rows = await sql<Array<{
    position: 'GKP'|'DEF'|'MID'|'FWD';
    n: number;
    sample_gws: number;
    mean_predicted: number;
    mean_actual: number;
  }>>`
    WITH snap AS (
      SELECT DISTINCT ON (player_id, fixture_id, gameweek_id)
             player_id, fixture_id, gameweek_id,
             xpts_total::float8 AS xpts_total
        FROM projection_snapshots
       WHERE gameweek_id IN (SELECT id FROM gameweeks WHERE finished = TRUE)
       ORDER BY player_id, fixture_id, gameweek_id, captured_at DESC
    ),
    actuals AS (
      SELECT player_id, gameweek_id,
             SUM(total_points)::float8 AS pts
        FROM player_gameweek_history
       GROUP BY player_id, gameweek_id
    ),
    pairs AS (
      SELECT p.position,
             snap.gameweek_id,
             SUM(snap.xpts_total)::float8 AS pred,
             COALESCE(MAX(a.pts), 0)::float8 AS actual
        FROM snap
        JOIN players p ON p.id = snap.player_id
        LEFT JOIN actuals a ON a.player_id = snap.player_id AND a.gameweek_id = snap.gameweek_id
       GROUP BY p.position, snap.gameweek_id, snap.player_id
    )
    SELECT position,
           COUNT(*)::int                    AS n,
           COUNT(DISTINCT gameweek_id)::int AS sample_gws,
           AVG(pred)::float8                AS mean_predicted,
           AVG(actual)::float8              AS mean_actual
      FROM pairs
     GROUP BY position
     ORDER BY position
  `;

  if (rows.length === 0) {
    console.log('[recompute-calibration] no finished-GW snapshots — leaving multipliers at 1.0');
    process.exit(0);
  }

  console.log('\n  Position   n   gws   predicted   actual   multiplier   confidence');
  for (const r of rows) {
    const meanPred = Number(r.mean_predicted) || 0;
    const meanAct  = Number(r.mean_actual)    || 0;
    const rawMult  = meanPred > 0 ? meanAct / meanPred : 1.0;
    // Clamp to [0.7, 1.6] — protects against pathological single-GW outliers.
    // A position should never be re-scaled by more than 40% either way; if
    // we're 40% off systematically, that's a deeper bug.
    const multiplier = Math.max(0.7, Math.min(1.6, rawMult));
    // Confidence ramps up with sample size. 300 (player, fixture) rows
    // ≈ 1 GW of finished data; full confidence at ~4 GWs.
    const confidence = Math.max(0, Math.min(1, Number(r.n) / 1200));

    console.log(`  ${r.position.padEnd(8)} ${String(r.n).padStart(4)} ${String(r.sample_gws).padStart(5)}   ${meanPred.toFixed(2).padStart(8)}   ${meanAct.toFixed(2).padStart(6)}   ${multiplier.toFixed(3).padStart(8)}   ${(confidence * 100).toFixed(0).padStart(8)}%`);

    await sql`
      INSERT INTO model_calibration
        (position, multiplier, confidence, sample_gws, mean_predicted, mean_actual, last_recomputed_at)
      VALUES
        (${r.position}, ${multiplier}, ${confidence}, ${r.sample_gws},
         ${meanPred}, ${meanAct}, now())
      ON CONFLICT (position) DO UPDATE
        SET multiplier         = EXCLUDED.multiplier,
            confidence         = EXCLUDED.confidence,
            sample_gws         = EXCLUDED.sample_gws,
            mean_predicted     = EXCLUDED.mean_predicted,
            mean_actual        = EXCLUDED.mean_actual,
            last_recomputed_at = now()
    `;
  }
  console.log('\n[recompute-calibration] done.');
  await sql.end({ timeout: 5 });
}

main().catch(err => { console.error(err); process.exit(1); });
