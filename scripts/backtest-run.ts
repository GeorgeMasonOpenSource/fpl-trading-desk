#!/usr/bin/env tsx
/**
 * Walk-forward backtest runner. Compares stored projection_snapshots
 * vs player_gameweek_history actuals over every finished gameweek.
 *
 * Usage:
 *   npm run backtest:run                     # full season, default
 *   START_GW=20 END_GW=37 npm run backtest:run
 *   BACKTEST_NAME='post-pen-fix' npm run backtest:run
 *
 * The name is what shows up on the /backtesting page. Use a clear
 * label for each model change you want to compare (e.g.
 * 'pre-pen-fix', 'post-pen-fix', 'with-recency-weighting').
 */
import { sql } from '../src/lib/db/client';
import { runBacktest } from '../src/lib/backtest/harness';

async function main() {
  const name = process.env.BACKTEST_NAME ?? `backtest-${new Date().toISOString().slice(0, 16)}`;

  // Resolve window. Default: all finished gameweeks where snapshots exist.
  const startGw = process.env.START_GW ? Number(process.env.START_GW) : null;
  const endGw   = process.env.END_GW   ? Number(process.env.END_GW)   : null;
  const window = await sql<Array<{ min_gw: number; max_gw: number }>>`
    SELECT MIN(ps.gameweek_id)::int AS min_gw, MAX(ps.gameweek_id)::int AS max_gw
      FROM projection_snapshots ps
      JOIN gameweeks g ON g.id = ps.gameweek_id
     WHERE g.finished = TRUE
  `;
  const auto = window[0] ?? { min_gw: 1, max_gw: 38 };
  const sg = startGw ?? auto.min_gw ?? 1;
  const eg = endGw   ?? auto.max_gw ?? 38;

  console.log(`→ Running backtest "${name}" over GW${sg}-${eg}…`);
  let summary;
  try {
    summary = await runBacktest(name, sg, eg);
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(1);
  }

  // Pretty print. The most important number is RMSE — that's the headline.
  console.log('');
  console.log(`  ${summary.totalRows.toLocaleString()} (player, fixture) pairs evaluated\n`);
  console.log(`  RMSE  ${summary.rmse.toFixed(3)}    (lower is better; quant-grade target 1.2)`);
  console.log(`  MAE   ${summary.mae.toFixed(3)}    (mean absolute error)`);
  console.log(`  Bias  ${summary.bias >= 0 ? '+' : ''}${summary.bias.toFixed(3)}   (positive = model under-predicts on average)`);
  console.log('');
  console.log(`  Hit-rate at ≥3 pts:  ${(summary.hitRate3.precision  * 100).toFixed(0)}% precision · ${(summary.hitRate3.recall  * 100).toFixed(0)}% recall   (${summary.hitRate3.count} predictions)`);
  console.log(`  Hit-rate at ≥6 pts:  ${(summary.hitRate6.precision  * 100).toFixed(0)}% precision · ${(summary.hitRate6.recall  * 100).toFixed(0)}% recall   (${summary.hitRate6.count} predictions)`);
  console.log(`  Hit-rate at ≥10 pts: ${(summary.hitRate10.precision * 100).toFixed(0)}% precision · ${(summary.hitRate10.recall * 100).toFixed(0)}% recall   (${summary.hitRate10.count} predictions)`);
  console.log('');
  console.log('  Calibration buckets (predicted → actual):');
  for (const b of summary.calibration) {
    const delta = b.meanActual - b.meanPredicted;
    const arrow = delta > 0.2 ? '↑' : delta < -0.2 ? '↓' : '·';
    console.log(`    ${b.bucket.padEnd(6)} n=${String(b.count).padStart(5)}   predicted ${b.meanPredicted.toFixed(2).padStart(6)}  vs  actual ${b.meanActual.toFixed(2).padStart(6)}  ${arrow}${Math.abs(delta).toFixed(2)}`);
  }
  console.log('');
  console.log('  Per-position:');
  for (const p of summary.byPosition) {
    if (p.count === 0) continue;
    console.log(`    ${p.position}   n=${String(p.count).padStart(5)}   RMSE ${p.rmse.toFixed(3)}   MAE ${p.mae.toFixed(3)}   bias ${p.bias >= 0 ? '+' : ''}${p.bias.toFixed(3)}`);
  }
  console.log('');
  console.log(`  Saved as run_id=${summary.runId}. See /backtesting for the rendered view.`);
  await sql.end();
}

main().catch(err => { console.error(err); process.exit(1); });
