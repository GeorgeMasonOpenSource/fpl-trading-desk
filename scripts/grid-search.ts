#!/usr/bin/env tsx
/**
 * Off-season hyperparameter grid search.
 *
 *   npm run grid:search
 *
 * Enumerates a coarse grid over the major engine tunables and runs
 * walk-forward backtests for each. Picks the config with the lowest
 * season-wide RMSE.
 *
 * Coarse grid (3 × 3 × 3 = 27 runs, ~5 minutes total):
 *   - mult_fwd      ∈ [0.9, 1.0, 1.1]
 *   - mult_mid      ∈ [0.9, 1.0, 1.1]
 *   - mult_def      ∈ [0.9, 1.0, 1.1]
 *
 * Future work: add more dimensions (recencyDecay, ensembleBlend, etc.)
 * once the engine accepts a cutoff_gameweek parameter so we can re-run
 * forward from scratch rather than scaling existing snapshots.
 */
import { sql } from '../src/lib/db/client';
import { gridSearch } from '../src/lib/backtest/walk-forward';

async function main() {
  console.log('[grid-search] starting coarse parameter sweep…\n');
  const results = await gridSearch({
    namePrefix: 'grid · ' + new Date().toISOString().slice(0, 10),
    grid: {
      mult_fwd: [0.9, 1.0, 1.1, 1.2],
      mult_mid: [0.9, 1.0, 1.1],
      mult_def: [0.9, 1.0, 1.1]
    }
  });

  console.log('\nTop 5 by RMSE:');
  console.log('  RMSE     MAE     bias     params');
  for (const r of results.slice(0, 5)) {
    const params = JSON.stringify(r.name.split('·').pop()?.trim() ?? '');
    console.log(`  ${r.rmse.toFixed(3)}   ${r.mae.toFixed(3)}   ${r.bias >= 0 ? '+' : ''}${r.bias.toFixed(3)}    ${params}`);
  }

  console.log('\nWinner: ' + (results[0]?.name ?? 'none'));
  console.log('See /backtesting page for the full ranked table.');
  await sql.end({ timeout: 5 });
}

main().catch(err => { console.error(err); process.exit(1); });
