import { sql } from '@/lib/db/client';

/**
 * Walk-forward backtest harness.
 *
 * The meta-tool that everything else depends on. For each finished
 * gameweek where we have BOTH a projection snapshot AND actuals, we
 * compute residuals (actual - predicted) per (player, fixture) and
 * aggregate them into:
 *
 *   - RMSE — root mean squared error. Bigger penalty for big misses.
 *     Target ceiling: ~1.2 (theoretical lower bound given football's
 *     irreducible variance). Current best public models: ~1.8-2.0.
 *
 *   - MAE  — mean absolute error. Linear penalty, easier to interpret
 *     than RMSE.
 *
 *   - Bias — mean signed residual. If positive, the model under-predicts
 *     systematically; if negative, it over-predicts. A well-calibrated
 *     model has |bias| < 0.1.
 *
 *   - Calibration buckets — predictions are bucketed (0-2, 2-4, 4-6,
 *     6+) and we compare the mean predicted within each bucket to the
 *     mean actual. A perfectly calibrated model has predicted ≈ actual
 *     in every bucket.
 *
 *   - Hit-rate-N — what fraction of "predicted ≥ N" actually scored
 *     ≥ N. Captures usefulness for transfer / captaincy decisions
 *     where we care about the tail, not the median.
 *
 *   - Per-position breakdown — same metrics split by GKP/DEF/MID/FWD.
 *     The model often performs very differently across positions.
 *
 * IMPORTANT — this uses `projection_snapshots` which is append-only,
 * written by the engine on every recompute. So the backtest is honest:
 * it grades the prediction WE MADE at the time, not a retroactive
 * recompute using future data.
 */

export interface BacktestSummary {
  runId: number;
  name: string;
  startGw: number;
  endGw: number;
  // Global metrics
  totalRows: number;
  rmse: number;
  mae: number;
  bias: number;
  // Hit rate buckets — predicted >= X, actual >= X
  hitRate3: { precision: number; recall: number; count: number };
  hitRate6: { precision: number; recall: number; count: number };
  hitRate10: { precision: number; recall: number; count: number };
  // Calibration: for each bucket, mean predicted vs mean actual.
  calibration: Array<{
    bucket: string; lower: number; upper: number;
    count: number; meanPredicted: number; meanActual: number;
  }>;
  // Per-position breakdown.
  byPosition: Array<{
    position: 'GKP' | 'DEF' | 'MID' | 'FWD';
    count: number; rmse: number; mae: number; bias: number;
  }>;
}

interface ResidualRow {
  player_id: number;
  position: 'GKP' | 'DEF' | 'MID' | 'FWD';
  gameweek_id: number;
  predicted: number;
  actual: number;
}

/**
 * Run the backtest over the given gameweek window. Saves results into
 * backtest_runs + backtest_results so they can be queried by the UI.
 */
export async function runBacktest(name: string, startGw: number, endGw: number): Promise<BacktestSummary> {
  // 1. Open a backtest_runs row so we have a stable id.
  const [{ id: runId }] = await sql<Array<{ id: number }>>`
    INSERT INTO backtest_runs (name, spec)
    VALUES (${name}, ${sql.json({ startGw, endGw })})
    RETURNING id
  `;

  try {
    // 2. Pull (prediction, actual) pairs for every finished GW in window.
    //    We take the LATEST snapshot per (player, fixture) — this is the
    //    "final" projection the user would have seen before lock.
    const rows = await sql<ResidualRow[]>`
      WITH latest_snapshot AS (
        SELECT DISTINCT ON (ps.player_id, ps.fixture_id)
               ps.player_id, ps.fixture_id, ps.gameweek_id,
               (ps.payload->>'xpts_total')::numeric AS predicted
          FROM projection_snapshots ps
          JOIN gameweeks g ON g.id = ps.gameweek_id
         WHERE g.finished = TRUE
           AND ps.gameweek_id BETWEEN ${startGw} AND ${endGw}
         ORDER BY ps.player_id, ps.fixture_id, ps.taken_at DESC
      )
      SELECT ls.player_id, p.position, ls.gameweek_id,
             ls.predicted::float8 AS predicted,
             pgh.total_points::float8 AS actual
        FROM latest_snapshot ls
        JOIN players p ON p.id = ls.player_id
        JOIN player_gameweek_history pgh
          ON pgh.player_id = ls.player_id
         AND pgh.fixture_id = ls.fixture_id
       WHERE pgh.minutes > 0
    `;

    if (rows.length === 0) {
      await sql`
        UPDATE backtest_runs
           SET finished_at = now(),
               summary = ${sql.json({ error: 'No matched snapshot+actual rows in window' })}
         WHERE id = ${runId}
      `;
      throw new Error(`No data: backtest window GW${startGw}-${endGw} has no snapshot/actual pairs.`);
    }

    // 3. Aggregate metrics.
    const summary = computeMetrics(rows, runId, name, startGw, endGw);

    // 4. Persist every metric in long form so the UI can query by metric/scope.
    const metricRows: any[] = [
      { run_id: runId, metric: 'rmse', scope: 'global', scope_value: null, value: summary.rmse, detail: null },
      { run_id: runId, metric: 'mae',  scope: 'global', scope_value: null, value: summary.mae,  detail: null },
      { run_id: runId, metric: 'bias', scope: 'global', scope_value: null, value: summary.bias, detail: null },
      { run_id: runId, metric: 'count', scope: 'global', scope_value: null, value: summary.totalRows, detail: null },
      { run_id: runId, metric: 'hit_rate_3',  scope: 'global', scope_value: null, value: summary.hitRate3.precision, detail: sql.json(summary.hitRate3) },
      { run_id: runId, metric: 'hit_rate_6',  scope: 'global', scope_value: null, value: summary.hitRate6.precision, detail: sql.json(summary.hitRate6) },
      { run_id: runId, metric: 'hit_rate_10', scope: 'global', scope_value: null, value: summary.hitRate10.precision, detail: sql.json(summary.hitRate10) }
    ];
    for (const b of summary.calibration) {
      metricRows.push({
        run_id: runId, metric: 'calibration', scope: 'bucket', scope_value: b.bucket,
        value: b.meanActual - b.meanPredicted, detail: sql.json(b)
      });
    }
    for (const p of summary.byPosition) {
      metricRows.push(
        { run_id: runId, metric: 'rmse', scope: 'position', scope_value: p.position, value: p.rmse, detail: null },
        { run_id: runId, metric: 'mae',  scope: 'position', scope_value: p.position, value: p.mae,  detail: null },
        { run_id: runId, metric: 'bias', scope: 'position', scope_value: p.position, value: p.bias, detail: null },
        { run_id: runId, metric: 'count', scope: 'position', scope_value: p.position, value: p.count, detail: null }
      );
    }
    await sql`
      INSERT INTO backtest_results ${(sql as any)(metricRows,
        'run_id', 'metric', 'scope', 'scope_value', 'value', 'detail')}
    `;

    // 5. Finalise the run with a JSON summary blob for quick UI rendering.
    await sql`
      UPDATE backtest_runs
         SET finished_at = now(), summary = ${sql.json(summary as any)}
       WHERE id = ${runId}
    `;
    return summary;
  } catch (err) {
    await sql`
      UPDATE backtest_runs
         SET finished_at = now(),
             summary = ${sql.json({ error: (err as Error).message })}
       WHERE id = ${runId}
    `.catch(() => void 0);
    throw err;
  }
}

function computeMetrics(
  rows: ResidualRow[], runId: number, name: string,
  startGw: number, endGw: number
): BacktestSummary {
  let sumSq = 0, sumAbs = 0, sumSigned = 0;
  for (const r of rows) {
    const e = r.actual - r.predicted;
    sumSq += e * e;
    sumAbs += Math.abs(e);
    sumSigned += e;
  }
  const n = rows.length;
  const rmse = Math.sqrt(sumSq / n);
  const mae  = sumAbs / n;
  const bias = sumSigned / n;

  // Hit-rate buckets — precision = predicted ≥ N AND actual ≥ N / predicted ≥ N
  //                    recall    = predicted ≥ N AND actual ≥ N / actual ≥ N
  const hitRate = (threshold: number) => {
    let predHits = 0, actualHits = 0, both = 0;
    for (const r of rows) {
      if (r.predicted >= threshold) predHits++;
      if (r.actual    >= threshold) actualHits++;
      if (r.predicted >= threshold && r.actual >= threshold) both++;
    }
    return {
      precision: predHits === 0 ? 0 : both / predHits,
      recall:    actualHits === 0 ? 0 : both / actualHits,
      count: predHits
    };
  };

  // Calibration: bucket by predicted score
  const buckets = [
    { name: '<2',   lower: -100, upper: 2 },
    { name: '2-4',  lower: 2,    upper: 4 },
    { name: '4-6',  lower: 4,    upper: 6 },
    { name: '6-9',  lower: 6,    upper: 9 },
    { name: '9+',   lower: 9,    upper: 100 }
  ];
  const calibration = buckets.map(b => {
    const inBucket = rows.filter(r => r.predicted >= b.lower && r.predicted < b.upper);
    const count = inBucket.length;
    const meanPredicted = count ? inBucket.reduce((s, r) => s + r.predicted, 0) / count : 0;
    const meanActual    = count ? inBucket.reduce((s, r) => s + r.actual, 0)    / count : 0;
    return { bucket: b.name, lower: b.lower, upper: b.upper, count, meanPredicted, meanActual };
  });

  // Per-position breakdown
  const positions: Array<'GKP' | 'DEF' | 'MID' | 'FWD'> = ['GKP', 'DEF', 'MID', 'FWD'];
  const byPosition = positions.map(pos => {
    const sub = rows.filter(r => r.position === pos);
    const count = sub.length;
    if (count === 0) return { position: pos, count: 0, rmse: 0, mae: 0, bias: 0 };
    let s2 = 0, sa = 0, ss = 0;
    for (const r of sub) {
      const e = r.actual - r.predicted;
      s2 += e * e; sa += Math.abs(e); ss += e;
    }
    return {
      position: pos, count,
      rmse: Math.sqrt(s2 / count),
      mae:  sa / count,
      bias: ss / count
    };
  });

  return {
    runId, name, startGw, endGw,
    totalRows: n,
    rmse, mae, bias,
    hitRate3:  hitRate(3),
    hitRate6:  hitRate(6),
    hitRate10: hitRate(10),
    calibration,
    byPosition
  };
}

/** Latest backtest run, including its full summary blob. Used by the page. */
export async function latestBacktestRun(): Promise<BacktestSummary | null> {
  const rows = await sql<Array<{ id: number; name: string; summary: any }>>`
    SELECT id, name, summary
      FROM backtest_runs
     WHERE finished_at IS NOT NULL
       AND summary IS NOT NULL
       AND (summary->>'error') IS NULL
     ORDER BY started_at DESC
     LIMIT 1
  `;
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return r.summary as BacktestSummary;
}
