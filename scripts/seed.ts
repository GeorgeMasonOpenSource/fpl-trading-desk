#!/usr/bin/env tsx
/**
 * Seed: run the FPL bootstrap + fixtures + (optional) manager + league + refresh.
 * Useful for first-time local dev. Idempotent. Reads env vars directly from
 * `process.env` — pass them inline:
 *   DATABASE_URL=... FPL_MANAGER_ID=... npm run db:seed
 *
 * Handles the live/planning split:
 *   - Pulls picks for BOTH the current GW (in-progress) and next GW (planning).
 *     If next-GW picks aren't yet available from FPL (you haven't set your
 *     lineup), it copies your current-GW squad to the next-GW slot so the
 *     planning views can render.
 *   - Pulls live event data for the in-progress GW so the dashboard live card
 *     gets real numbers.
 *   - Recomputes minutes + projections for both GWs.
 */
import { fpl } from '../src/lib/fpl/client';
import {
  upsertBootstrap, upsertFixtures, upsertManagerEntry, upsertManagerPicks,
  upsertClassicLeague, upsertEventLive, upsertManagerLeagues
} from '../src/lib/fpl/normalise';
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

  // Determine current + next GW from the gameweeks table after bootstrap.
  const currentRows = await sql<Array<{ id: number }>>`
    SELECT id FROM gameweeks WHERE is_current = TRUE LIMIT 1
  `;
  const nextRows = await sql<Array<{ id: number }>>`
    SELECT id FROM gameweeks WHERE is_next = TRUE LIMIT 1
  `;
  const currentGw = currentRows[0]?.id ?? null;
  const nextGw    = nextRows[0]?.id ?? null;
  console.log(`→ gameweeks: current=${currentGw ?? '—'}, next=${nextGw ?? '—'}`);

  const managerId = Number(process.env.FPL_MANAGER_ID ?? 0);
  const leagueId  = Number(process.env.FPL_LEAGUE_ID ?? 0);

  if (managerId) {
    console.log(`→ manager ${managerId}`);
    const entry = await fpl.managerEntry(managerId);
    await upsertManagerEntry(entry, 1);
    await upsertManagerLeagues(managerId, entry);
    const leagueCount = (entry.leagues?.classic?.length ?? 0) + (entry.leagues?.h2h?.length ?? 0);
    console.log(`  found ${leagueCount} leagues`);

    // Picks for the current (in-progress) GW
    if (currentGw) {
      console.log(`→ picks for current GW ${currentGw}`);
      try {
        const picks = await fpl.managerPicks(managerId, currentGw);
        await upsertManagerPicks(managerId, currentGw, picks);
      } catch (err) {
        console.warn(`  could not pull current GW picks: ${(err as Error).message}`);
      }
    }

    // Picks for the next (planning) GW — falls back to copying current GW
    // picks when FPL hasn't generated next-GW picks yet (no lineup change yet).
    if (nextGw) {
      console.log(`→ picks for next GW ${nextGw}`);
      try {
        const picks = await fpl.managerPicks(managerId, nextGw);
        await upsertManagerPicks(managerId, nextGw, picks);
      } catch {
        if (currentGw) {
          console.log(`  next GW picks not available yet — copying from GW ${currentGw}`);
          await sql`
            INSERT INTO manager_picks (manager_id, gameweek_id, player_id, position,
                                       is_captain, is_vice, multiplier,
                                       purchase_price, selling_price)
            SELECT manager_id, ${nextGw}, player_id, position, is_captain, is_vice,
                   multiplier, purchase_price, selling_price
            FROM manager_picks
            WHERE manager_id = ${managerId} AND gameweek_id = ${currentGw}
            ON CONFLICT DO NOTHING
          `;
        }
      }
    }

    if (leagueId) {
      console.log(`→ league ${leagueId}`);
      const snapshotGw = currentGw ?? nextGw ?? 0;
      await upsertClassicLeague(await fpl.classicLeague(leagueId), snapshotGw);
    }
  }

  // Live event data for the in-progress GW — populates the live dashboard card.
  if (currentGw) {
    console.log(`→ live event data for GW ${currentGw}`);
    try {
      const live = await fpl.eventLive(currentGw);
      await upsertEventLive(currentGw, live);
    } catch (err) {
      console.warn(`  live event fetch failed: ${(err as Error).message}`);
    }
  }

  console.log('→ team strengths');
  await recomputeTeamStrengths();
  console.log('→ baselines');
  await recomputeBaselines();

  // Recompute minutes + projections for both gameweeks.
  for (const gw of [currentGw, nextGw].filter((x): x is number => x != null)) {
    console.log(`→ minutes for GW ${gw}`);
    await recomputeMinutesForGameweek(gw);
    console.log(`→ projections for GW ${gw}`);
    await recomputeProjectionsForGameweek(gw);
  }

  console.log('done.');
  await sql.end();
}

main().catch(err => { console.error(err); process.exit(1); });
