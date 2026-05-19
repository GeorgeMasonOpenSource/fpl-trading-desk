#!/usr/bin/env tsx
/**
 * Seed: run the FPL bootstrap + fixtures + (optional) manager + league + refresh.
 * Useful for first-time local dev. Idempotent. Reads env vars directly from
 * `process.env` — pass them inline:
 *   DATABASE_URL=... FPL_MANAGER_ID=... npm run db:seed
 */
import { fpl } from '../src/lib/fpl/client';
import { upsertBootstrap, upsertFixtures, upsertManagerEntry, upsertManagerPicks, upsertClassicLeague } from '../src/lib/fpl/normalise';
import { sql } from '../src/lib/db/client';
import { recomputeBaselines } from '../src/lib/projections/baseline';
import { recomputeTeamStrengths } from '../src/lib/projections/team-strength';
import { recomputeMinutesForGameweek } from '../src/lib/minutes/engine';
import { recomputeProjectionsForGameweek } from '../src/lib/projections/engine';

async function main() {
  console.log('→ bootstrap');
  const bs = await fpl.bootstrap();
  await upsertBootstrap(bs);
  console.log('→ fixtures');
  await upsertFixtures(await fpl.fixtures());

  const managerId = Number(process.env.FPL_MANAGER_ID ?? 0);
  const leagueId = Number(process.env.FPL_LEAGUE_ID ?? 0);
  if (managerId) {
    console.log(`→ manager ${managerId}`);
    const entry = await fpl.managerEntry(managerId);
    await upsertManagerEntry(entry, 1);
    const gwRows = await sql<Array<{ id: number }>>`
      SELECT id FROM gameweeks WHERE is_current = TRUE UNION ALL
      SELECT id FROM gameweeks WHERE is_next = TRUE LIMIT 1
    `;
    const currentGw = gwRows[0]?.id;
    if (currentGw) {
      const picks = await fpl.managerPicks(managerId, currentGw);
      await upsertManagerPicks(managerId, currentGw, picks);
    }
    if (leagueId) {
      console.log(`→ league ${leagueId}`);
      await upsertClassicLeague(await fpl.classicLeague(leagueId), currentGw ?? 0);
    }
  }

  console.log('→ team strengths');
  await recomputeTeamStrengths();
  console.log('→ baselines');
  await recomputeBaselines();

  const gwRows = await sql<Array<{ id: number }>>`
    SELECT id FROM gameweeks WHERE is_current = TRUE UNION ALL
    SELECT id FROM gameweeks WHERE is_next = TRUE LIMIT 1
  `;
  const gw = gwRows[0]?.id;
  if (gw) {
    console.log(`→ minutes for GW ${gw}`);
    await recomputeMinutesForGameweek(gw);
    console.log(`→ projections for GW ${gw}`);
    await recomputeProjectionsForGameweek(gw);
  }

  console.log('done.');
  await sql.end();
}

main().catch(err => { console.error(err); process.exit(1); });
