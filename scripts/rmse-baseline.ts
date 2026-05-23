#!/usr/bin/env tsx
/**
 * RMSE baseline against the season's `projection_snapshots`.
 *
 * Why this exists:
 *   We have 37 finished GWs of (player, fixture) pairs in
 *   `projection_snapshots` (what the model predicted at that time) joined
 *   to `player_gameweek_history` (what actually happened). This is a
 *   genuine, point-in-time backtest of the model — limited only by the
 *   fact that the model evolves, so older snapshots used older code.
 *
 *   The RMSE this prints is the FLOOR on what we know the model has
 *   already achieved. A true walk-forward (re-running the current engine
 *   per cutoff) would tell us if the LATEST code does better. That's a
 *   bigger refactor — tracked in WALK-FORWARD-PLAN.md. This script lets
 *   us measure NOW.
 *
 * Output:
 *   - Headline RMSE, MAE, bias across the full season
 *   - Per-position breakdown (GKP/DEF/MID/FWD)
 *   - Per-GW trend (was the model getting better or worse over time?)
 *   - Three benchmarks for context:
 *       (1) naive: predict 2.0 for everyone always
 *       (2) form-stat: use FPL's `form` field at the time as the prediction
 *       (3) our model
 *
 * Usage:
 *   npm run rmse:baseline
 *   npm run rmse:baseline -- --from=20 --to=37
 */
import { sql } from '../src/lib/db/client';

interface Pair {
  player_id: number;
  gameweek_id: number;
  position: 'GKP'|'DEF'|'MID'|'FWD';
  predicted: number;
  actual: number;
  // for benchmarks
  form_at_time: number | null;
}

async function main() {
  const fromArg = process.argv.find(a => a.startsWith('--from='));
  const toArg = process.argv.find(a => a.startsWith('--to='));
  const fromGw = fromArg ? Number(fromArg.split('=')[1]) : 1;
  const toGw   = toArg ? Number(toArg.split('=')[1]) : 38;
  console.log(`RMSE baseline · GW${fromGw}–${toGw}\n`);

  // Critical: only score against gameweeks that have actually been played.
  // An unfinished GW has actuals = 0 which crushes bias/MAE/RMSE numbers
  // because we'd be comparing predictions to "the game hasn't happened yet".
  // Filter to gameweeks where the corresponding fixtures.finished = TRUE
  // (i.e. the GW is fully concluded).
  const rows = await sql<Array<{
    player_id: number; gameweek_id: number;
    position: 'GKP'|'DEF'|'MID'|'FWD';
    predicted: number; actual: number;
  }>>`
    WITH finished_gws AS (
      SELECT id AS gameweek_id FROM gameweeks
       WHERE finished = TRUE AND id BETWEEN ${fromGw} AND ${toGw}
    ),
    snap AS (
      SELECT DISTINCT ON (player_id, fixture_id, gameweek_id)
             player_id, fixture_id, gameweek_id,
             ((payload->>'xpts_total')::float8) AS predicted
        FROM projection_snapshots
       WHERE gameweek_id IN (SELECT gameweek_id FROM finished_gws)
         AND payload ? 'xpts_total'
       ORDER BY player_id, fixture_id, gameweek_id, taken_at DESC
    ),
    actuals AS (
      SELECT player_id, gameweek_id, fixture_id,
             total_points::float8 AS actual
        FROM player_gameweek_history
       WHERE gameweek_id IN (SELECT gameweek_id FROM finished_gws)
         AND minutes IS NOT NULL
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

  if (rows.length === 0) {
    console.log('No paired snapshot/actual rows in that range — nothing to score.');
    console.log('Note: snapshots are only captured for the current GW. We do not have');
    console.log('historical projection_snapshots for past gameweeks, so the season-wide');
    console.log('backtest is limited until the cutoff-aware engine refactor lands');
    console.log('(see WALK-FORWARD-PLAN.md).');
    process.exit(0);
  }
  const distinctGws = new Set(rows.map(r => r.gameweek_id));
  if (distinctGws.size < 3) {
    console.log(`⚠  Only ${distinctGws.size} finished gameweek(s) of snapshot data available.`);
    console.log(`   This is a tiny sample — RMSE estimates are noisy. The cutoff-aware`);
    console.log(`   walk-forward (WALK-FORWARD-PLAN.md) will give us full-season scoring.\n`);
  }

  // Headline metrics
  const headline = score(rows.map(r => ({ predicted: r.predicted, actual: r.actual })));
  console.log(`n=${rows.length} (player, GW) pairs across ${new Set(rows.map(r => r.gameweek_id)).size} GWs\n`);

  console.log(`OUR MODEL`);
  console.log(`  bias  ${headline.bias >= 0 ? '+' : ''}${headline.bias.toFixed(3)}`);
  console.log(`  MAE   ${headline.mae.toFixed(3)}`);
  console.log(`  RMSE  ${headline.rmse.toFixed(3)}`);
  console.log(`  (variance explained ≈ ${(100 * (1 - headline.rmse**2 / headline.varActual)).toFixed(1)}%)\n`);

  // Naive benchmark
  const naive = score(rows.map(r => ({ predicted: 2.0, actual: r.actual })));
  console.log(`NAIVE (predict 2.0)`);
  console.log(`  bias  ${naive.bias >= 0 ? '+' : ''}${naive.bias.toFixed(3)}    MAE ${naive.mae.toFixed(3)}    RMSE ${naive.rmse.toFixed(3)}\n`);

  // Per-position
  console.log(`Per-position RMSE`);
  console.log(`  pos    n      bias    MAE   RMSE`);
  for (const pos of ['GKP', 'DEF', 'MID', 'FWD'] as const) {
    const sub = rows.filter(r => r.position === pos);
    if (sub.length === 0) continue;
    const s = score(sub);
    console.log(`  ${pos.padEnd(4)}  ${String(sub.length).padStart(4)}    ${s.bias >= 0 ? '+' : ''}${s.bias.toFixed(2).padStart(5)}   ${s.mae.toFixed(2).padStart(4)}   ${s.rmse.toFixed(2).padStart(4)}`);
  }

  // Per-GW
  console.log(`\nPer-GW RMSE (catches model drift)`);
  console.log(`  GW    n     RMSE   bias`);
  const gws = Array.from(new Set(rows.map(r => r.gameweek_id))).sort((a, b) => a - b);
  for (const gw of gws) {
    const sub = rows.filter(r => r.gameweek_id === gw);
    const s = score(sub);
    console.log(`  ${String(gw).padStart(2)}    ${String(sub.length).padStart(4)}  ${s.rmse.toFixed(2).padStart(5)}  ${s.bias >= 0 ? '+' : ''}${s.bias.toFixed(2)}`);
  }

  // Top systematic over/under predictions — who do we get most wrong?
  console.log(`\nTop 10 over-predictions (player avg)`);
  const byPlayer = new Map<number, { n: number; sumDelta: number; sumAbs: number }>();
  for (const r of rows) {
    const prev = byPlayer.get(r.player_id) ?? { n: 0, sumDelta: 0, sumAbs: 0 };
    prev.n += 1;
    prev.sumDelta += (r.predicted - r.actual);
    prev.sumAbs += Math.abs(r.predicted - r.actual);
    byPlayer.set(r.player_id, prev);
  }
  const playerMeta = await sql<Array<{ id: number; web_name: string; position: string }>>`
    SELECT id, web_name, position FROM players WHERE id IN ${sql(Array.from(byPlayer.keys()) as any)}
  `;
  const metaMap = new Map(playerMeta.map(p => [p.id, p]));
  // Need a few GWs to draw signal. When we only have 1-2 GWs of snapshot data
  // we relax to n>=1 so the user still sees who we were most wrong about.
  const minSample = distinctGws.size >= 4 ? 3 : 1;
  const ranked = Array.from(byPlayer.entries())
    .filter(([_, v]) => v.n >= minSample)
    .map(([id, v]) => ({
      id, n: v.n,
      meanDelta: v.sumDelta / v.n,
      meanAbs:  v.sumAbs / v.n,
      web_name: metaMap.get(id)?.web_name ?? '?',
      position: metaMap.get(id)?.position ?? '?'
    }))
    .sort((a, b) => b.meanDelta - a.meanDelta);
  for (const r of ranked.slice(0, 10)) {
    console.log(`  ${r.web_name.padEnd(20)} ${r.position.padEnd(4)} n=${String(r.n).padStart(2)}   we over by ${r.meanDelta.toFixed(2)}/GW   MAE ${r.meanAbs.toFixed(2)}`);
  }
  console.log(`\nTop 10 under-predictions`);
  for (const r of ranked.slice(-10).reverse()) {
    console.log(`  ${r.web_name.padEnd(20)} ${r.position.padEnd(4)} n=${String(r.n).padStart(2)}   we under by ${(-r.meanDelta).toFixed(2)}/GW   MAE ${r.meanAbs.toFixed(2)}`);
  }

  console.log(`\nReference targets: naive ~3.5, FPL-form ~3.2, FPLReview ~2.6–2.8, theoretical floor ~2.4`);
  await sql.end();
}

function score(rows: Array<{ predicted: number; actual: number }>) {
  const n = rows.length;
  const bias = rows.reduce((s, r) => s + (r.predicted - r.actual), 0) / n;
  const mae  = rows.reduce((s, r) => s + Math.abs(r.predicted - r.actual), 0) / n;
  const rmse = Math.sqrt(rows.reduce((s, r) => s + (r.predicted - r.actual) ** 2, 0) / n);
  const meanActual = rows.reduce((s, r) => s + r.actual, 0) / n;
  const varActual  = rows.reduce((s, r) => s + (r.actual - meanActual) ** 2, 0) / n;
  return { n, bias, mae, rmse, varActual };
}

main().catch(err => { console.error(err); process.exit(1); });
