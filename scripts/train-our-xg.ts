#!/usr/bin/env tsx
/**
 * Train our own xG model and report calibration vs Understat.
 *
 *   npm run train:xg
 */
import { sql } from '../src/lib/db/client';
import { trainOurXg, persistCoefs } from '../src/lib/xg/our-xg-model';

async function main() {
  console.log('[train-our-xg] starting training…\n');
  const out = await trainOurXg({ iterations: 400 });
  await persistCoefs();
  console.log(`  ${out.nTrain} train shots · ${out.nTest} test shots`);
  console.log(`  Coefficients:`);
  for (const [k, v] of Object.entries(out.coefs)) {
    console.log(`    ${k.padEnd(12)} ${(v as number).toFixed(4)}`);
  }
  console.log('');
  console.log(`  log-loss · train ${out.trainLogLoss.toFixed(4)}`);
  console.log(`  log-loss · test  ${out.testLogLoss.toFixed(4)}    ← our model`);
  console.log(`  log-loss · understat ${out.understatLogLoss.toFixed(4)}    ← reference`);
  console.log('');
  if (out.testLogLoss < out.understatLogLoss) {
    console.log(`  ✅ Our model beats Understat on this set by ${(out.understatLogLoss - out.testLogLoss).toFixed(4)} log-loss`);
  } else {
    console.log(`  ⚠  Understat still beats us by ${(out.testLogLoss - out.understatLogLoss).toFixed(4)} log-loss — more features needed`);
  }
  await sql.end({ timeout: 5 });
}

main().catch(err => { console.error(err); process.exit(1); });
