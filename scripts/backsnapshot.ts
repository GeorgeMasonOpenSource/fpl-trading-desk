#!/usr/bin/env tsx
/**
 * Back-snapshot — run the CURRENT engine over every past finished GW
 * and write the results to `projection_snapshots` so `rmse:baseline`
 * has more than 1 GW of data to score against.
 *
 * IMPORTANT — data leakage warning:
 *
 *   This is NOT a fair backtest. The engine uses CURRENT data — current
 *   team strengths (fitted on all 37 GWs), current season totals,
 *   current Understat aggregates, current calibration multipliers.
 *   So when it "predicts" GW20, it has access to GW21-37 results.
 *
 *   The number this produces is the UPPER BOUND on what the current
 *   model could achieve if it had perfect hindsight on team strengths
 *   etc. The actual model's GW20 performance was worse, because at the
 *   time it didn't know about GW21-37.
 *
 *   To get the FAIR backtest, we need the cutoff-aware engine refactor
 *   in WALK-FORWARD-PLAN.md (~3 days off-season).
 *
 *   What this script IS good for: spotting players the current model
 *   systematically over/under-rates across the whole season. If we
 *   over-predict Salah by +1.5 per GW across 37 GWs, that's a signal
 *   even though the absolute RMSE is optimistic.
 *
 * Usage:
 *   npm run backsnapshot              # all finished GWs
 *   npm run backsnapshot -- --from=20 --to=37   # specific range
 *
 * Runtime: ~3 seconds per GW × 37 GWs ≈ 2 minutes.
 */
import { sql } from '../src/lib/db/client';
import { recomputeProjectionsForGameweek } from '../src/lib/projections/engine';

async function main() {
  const fromArg = process.argv.find(a => a.startsWith('--from='));
  const toArg = process.argv.find(a => a.startsWith('--to='));
  const fromGw = fromArg ? Number(fromArg.split('=')[1]) : 1;
  const toArgN  = toArg  ? Number(toArg.split('=')[1])  : 0;

  // Default: every finished GW.
  const finished = await sql<Array<{ id: number }>>`
    SELECT id FROM gameweeks
     WHERE finished = TRUE AND id >= ${fromGw}
     ${toArgN > 0 ? sql`AND id <= ${toArgN}` : sql``}
     ORDER BY id
  `;
  if (finished.length === 0) {
    console.log('No finished gameweeks to back-snapshot.');
    process.exit(0);
  }
  console.log(`Back-snapshotting ${finished.length} GWs: ${finished.map(r => r.id).join(', ')}`);
  console.log(`⚠  LEAKY backtest — current team/player state used to predict past. See script header.`);
  console.log();

  let ok = 0, fail = 0;
  for (const { id: gw } of finished) {
    const t0 = Date.now();
    try {
      // includeFinished=true is essential here — the live engine filters
      // OUT finished fixtures (you don't predict games that already happened
      // in normal flow). For back-snapshot we WANT to predict the finished
      // fixtures so we can score against actuals.
      await recomputeProjectionsForGameweek(gw, { includeFinished: true });
      console.log(`  GW${String(gw).padStart(2)}: ✓  (${Date.now() - t0}ms)`);
      ok++;
    } catch (err) {
      console.log(`  GW${String(gw).padStart(2)}: ✗  ${(err as Error).message.split('\n')[0]}`);
      fail++;
    }
  }

  console.log(`\nDone. ${ok} succeeded, ${fail} failed.`);
  console.log(`Now run:  npm run rmse:baseline`);
  await sql.end();
}

main().catch(err => { console.error(err); process.exit(1); });
