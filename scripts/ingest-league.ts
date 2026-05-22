#!/usr/bin/env tsx
/**
 * Mini-league ingest. Pulls classic league standings + every rival's picks
 * for the current/next gameweek, so the Mini-League War Room has data to
 * compute EO, threats, captain differences, etc.
 *
 * The Mini-League page was previously showing an empty Threats panel
 * because nobody was ever writing rival picks into `manager_picks`. This
 * script closes that gap.
 *
 * Usage:
 *   LEAGUE_ID=1646336 npm run ingest:league
 *   # or all of the connected manager's leagues:
 *   FPL_MANAGER_ID=319921 npm run ingest:league
 *
 * Idempotent: classic_league_standings uses (league_id, gw, entry, snapshot_at)
 * PK so re-runs add new snapshots without overwriting history. manager_picks
 * is upserted by (manager_id, gameweek_id, position).
 */
import { sql } from '../src/lib/db/client';
import { fpl } from '../src/lib/fpl/client';

interface ClassicStandingsResult {
  league: { id: number; name: string };
  standings: { results: Array<{
    rank: number;
    last_rank: number | null;
    entry: number;
    entry_name: string;
    player_name: string;
    total: number;
    event_total: number;
  }> };
}

interface ManagerPicksResult {
  picks: Array<{
    element: number;
    position: number;
    multiplier: number;
    is_captain: boolean;
    is_vice_captain: boolean;
  }>;
  active_chip: string | null;
  entry_history?: { event_transfers: number; bank: number; value: number };
}

async function ingestLeague(leagueId: number, gameweekId: number) {
  // 1. Pull standings (page 1 covers the top 50; that's enough for war-room
  //    purposes, no real value past rank 50 — fight-for-the-top is a top-N
  //    problem).
  const raw = await fpl.classicLeague(leagueId, 1) as unknown as ClassicStandingsResult;
  if (!raw?.standings?.results) {
    console.warn(`  league ${leagueId}: no standings returned`);
    return { rivals: 0, picks: 0 };
  }
  const rows = raw.standings.results;
  console.log(`→ league ${leagueId} (${raw.league.name}): ${rows.length} entries`);

  // 2. Upsert the standings snapshot.
  if (rows.length > 0) {
    await sql`
      INSERT INTO classic_league_standings ${(sql as any)(
        rows.map(r => ({
          league_id: leagueId,
          gameweek_id: gameweekId,
          rank: r.rank,
          last_rank: r.last_rank ?? null,
          entry: r.entry,
          entry_name: r.entry_name,
          player_name: r.player_name,
          total: r.total,
          event_total: r.event_total
        })),
        'league_id', 'gameweek_id', 'rank', 'last_rank',
        'entry', 'entry_name', 'player_name', 'total', 'event_total'
      )}
    `;

    // 2b. Upsert manager_teams stubs for every rival. The picks insert FKs
    //     against this table, so without this step we'd get a "manager_picks
    //     violates foreign key constraint" error. We fill in just the
    //     minimum required fields (id + name + player name); the full
    //     manager-team payload is pulled by the live manager ingest for
    //     the connected user only.
    await sql`
      INSERT INTO manager_teams ${(sql as any)(
        rows.map(r => {
          const firstSpace = r.player_name.indexOf(' ');
          const first = firstSpace >= 0 ? r.player_name.slice(0, firstSpace) : r.player_name;
          const last  = firstSpace >= 0 ? r.player_name.slice(firstSpace + 1) : '';
          return {
            manager_id: r.entry,
            name: r.entry_name,
            player_first_name: first,
            player_last_name: last,
            total_points: r.total
          };
        }),
        'manager_id', 'name', 'player_first_name', 'player_last_name', 'total_points'
      )}
      ON CONFLICT (manager_id) DO UPDATE SET
        name              = EXCLUDED.name,
        player_first_name = EXCLUDED.player_first_name,
        player_last_name  = EXCLUDED.player_last_name,
        total_points      = EXCLUDED.total_points,
        updated_at        = now()
    `;
  }

  // 3. Pull picks for every rival entry. We hit /entry/{id}/event/{gw}/picks/
  //    in parallel batches of 8 to be polite to the FPL API.
  const BATCH = 8;
  let totalPicks = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(r => fpl.managerPicks(r.entry, gameweekId))
    );
    const picksRows: any[] = [];
    for (let j = 0; j < batch.length; j++) {
      const settled = results[j];
      const entry = batch[j]!;
      if (settled?.status !== 'fulfilled') continue;
      const pr = settled.value as unknown as ManagerPicksResult;
      if (!pr?.picks) continue;
      for (const p of pr.picks) {
        picksRows.push({
          manager_id:    entry.entry,
          gameweek_id:   gameweekId,
          player_id:     p.element,
          position:      p.position,
          multiplier:    p.multiplier,
          is_captain:    p.is_captain,
          is_vice:       p.is_vice_captain,
          selling_price: null   // FPL only exposes selling price to the entry's owner
        });
      }
    }
    if (picksRows.length > 0) {
      await sql`
        INSERT INTO manager_picks ${(sql as any)(picksRows,
          'manager_id', 'gameweek_id', 'player_id', 'position',
          'multiplier', 'is_captain', 'is_vice', 'selling_price')}
        ON CONFLICT (manager_id, gameweek_id, position) DO UPDATE SET
          player_id  = EXCLUDED.player_id,
          multiplier = EXCLUDED.multiplier,
          is_captain = EXCLUDED.is_captain,
          is_vice    = EXCLUDED.is_vice
      `;
      totalPicks += picksRows.length;
    }
  }
  console.log(`  → ${totalPicks} picks ingested for ${rows.length} rivals`);
  return { rivals: rows.length, picks: totalPicks };
}

async function main() {
  // Resolve which gameweek to ingest for. Prefer the current GW (live), so
  // the war room reflects the actively-running matches. If no current GW
  // (between deadlines), use the next.
  const gwRow = await sql<Array<{ id: number; is_current: boolean; is_next: boolean }>>`
    SELECT id, is_current, is_next FROM gameweeks
     WHERE is_current = TRUE OR is_next = TRUE
     ORDER BY is_current DESC
     LIMIT 1
  `;
  const gw = gwRow[0]?.id;
  if (!gw) {
    console.error('No current/next gameweek in the DB — run db:seed first.');
    process.exit(1);
  }
  console.log(`→ ingesting picks for GW ${gw}`);

  // Resolve which leagues to ingest. Either an explicit LEAGUE_ID, or every
  // league the connected manager belongs to.
  let leagueIds: number[];
  if (process.env.LEAGUE_ID) {
    leagueIds = [Number(process.env.LEAGUE_ID)];
  } else {
    const managerId = Number(process.env.FPL_MANAGER_ID);
    if (!managerId) {
      console.error('Set LEAGUE_ID=... or FPL_MANAGER_ID=... to pick what to ingest.');
      process.exit(1);
    }
    const myLeagues = await sql<Array<{ league_id: number }>>`
      SELECT league_id FROM manager_leagues
       WHERE manager_id = ${managerId} AND scoring = 'c'
       ORDER BY league_id
    `;
    leagueIds = myLeagues.map(l => l.league_id);
    if (leagueIds.length === 0) {
      console.warn('Manager has no classic leagues yet — run db:seed to pull them.');
      process.exit(0);
    }
  }

  let totalRivals = 0;
  let totalPicks = 0;
  for (const id of leagueIds) {
    try {
      const r = await ingestLeague(id, gw);
      totalRivals += r.rivals;
      totalPicks  += r.picks;
    } catch (err) {
      console.warn(`  league ${id}: ${(err as Error).message}`);
    }
  }
  console.log(`done. ${totalRivals} rival entries, ${totalPicks} picks across ${leagueIds.length} leagues.`);
  await sql.end();
}

main().catch(err => { console.error(err); process.exit(1); });
