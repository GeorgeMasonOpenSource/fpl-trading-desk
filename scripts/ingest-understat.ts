#!/usr/bin/env tsx
/**
 * Understat per-shot xG ingest. Pulls every shot for every PL match in
 * the current season, matches each shot's player to an FPL player_id by
 * name + team, persists per-shot rows, then refreshes per-player
 * per-situation aggregates that the projection engine reads.
 *
 *   npm run ingest:understat
 *
 * Idempotent — UNIQUE (understat_id) ON CONFLICT DO NOTHING. Safe to
 * re-run mid-season; only new shots get inserted.
 *
 * Run frequency: once per matchday is plenty. The per-season `playersData`
 * blob (which lists Understat IDs by team) is what we cache; if a new
 * player has joined since our last run, they won't be in our DB yet and
 * the matcher will skip them — which is the right behaviour, the next
 * db:seed picks them up.
 */
import { sql } from '../src/lib/db/client';
import {
  fetchAllMatchIds,
  fetchMatchShots,
  fetchLeaguePlayers,
  type UnderstatShot
} from '../src/lib/understat/scraper';

async function main() {
  // Season-start year. Default to current calendar year if month >= July,
  // else previous year. (Aug 2025 → 2025; March 2026 → 2025.)
  const now = new Date();
  const defaultYear = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const year = Number(process.env.UNDERSTAT_YEAR ?? defaultYear);
  console.log(`→ Understat season ${year}/${year + 1}`);

  // 1. Build a name+team → player_id resolver from our FPL roster.
  const teams = await sql<Array<{ id: number; name: string; short_name: string }>>`
    SELECT id, name, short_name FROM teams
  `;
  const teamByName = new Map<string, number>();
  for (const t of teams) {
    teamByName.set(t.name.toLowerCase(), t.id);
    teamByName.set(t.short_name.toLowerCase(), t.id);
  }
  const fplPlayers = await sql<Array<{
    id: number; web_name: string; first_name: string; second_name: string; team_id: number;
  }>>`
    SELECT id, web_name, first_name, second_name, team_id FROM players
  `;
  const playerKey = (firstLast: string, teamId: number) => `${firstLast.toLowerCase()}|${teamId}`;
  const playerMap = new Map<string, number>();
  for (const p of fplPlayers) {
    const full = `${p.first_name} ${p.second_name}`;
    playerMap.set(playerKey(full, p.team_id), p.id);
    // Also map web_name and last-name-only as fallbacks
    playerMap.set(playerKey(p.web_name, p.team_id), p.id);
    const last = p.second_name.split(/\s+/).pop() ?? p.web_name;
    playerMap.set(playerKey(last, p.team_id), p.id);
  }
  const resolveFplId = (understatName: string, teamLongName: string): number | null => {
    const teamId = teamByName.get(teamLongName.toLowerCase());
    if (!teamId) return null;
    // Try full name, then last word.
    const tries = [
      understatName,
      understatName.split(/\s+/).pop() ?? understatName
    ];
    for (const t of tries) {
      const id = playerMap.get(playerKey(t, teamId));
      if (id) return id;
    }
    return null;
  };

  // 2. Get the Understat-side per-season aggregates first — we use the
  //    league-players list to derive a Understat-player-id → fpl-player-id
  //    map BEFORE walking matches, which speeds up shot resolution
  //    (lookup by Understat ID is O(1)).
  const understatPlayers = await fetchLeaguePlayers(year);
  const understatIdToFpl = new Map<string, number>();
  let resolvedPlayers = 0;
  for (const up of understatPlayers) {
    const fplId = resolveFplId(up.player_name, up.team_title.split(',')[0]!);
    if (fplId) {
      understatIdToFpl.set(up.id, fplId);
      resolvedPlayers++;
    }
  }
  console.log(`→ resolved ${resolvedPlayers}/${understatPlayers.length} Understat players to FPL IDs`);

  // 3. Enumerate every match this season, fetch shots for each.
  const matchIds = await fetchAllMatchIds(year);
  console.log(`→ ${matchIds.size} matches found this season`);
  const allShotRows: any[] = [];
  let unmatchedPlayers = 0;
  let processed = 0;
  for (const matchId of matchIds) {
    try {
      const shots = await fetchMatchShots(matchId);
      for (const s of shots) {
        const fplId = understatIdToFpl.get(s.player_id);
        if (!fplId) { unmatchedPlayers++; continue; }
        const teamLong = s.h_a === 'h' ? s.h_team : s.a_team;
        const oppLong  = s.h_a === 'h' ? s.a_team : s.h_team;
        const teamId = teamByName.get(teamLong.toLowerCase()) ?? null;
        const oppId  = teamByName.get(oppLong.toLowerCase())  ?? null;
        allShotRows.push({
          understat_id:     s.id,
          player_id:        fplId,
          match_date:       s.date.slice(0, 10),
          team_id:          teamId,
          opponent_team_id: oppId,
          is_home:          s.h_a === 'h',
          minute:           Number(s.minute) || 0,
          xg:               Number(s.xG) || 0,
          situation:        s.situation,
          shot_type:        s.shotType,
          result:           s.result,
          x_loc:            Number(s.X)  || null,
          y_loc:            Number(s.Y)  || null
        });
      }
      processed++;
      if (processed % 20 === 0) console.log(`  ${processed} / ${matchIds.size} matches…`);
    } catch (err) {
      console.warn(`  match ${matchId}: ${(err as Error).message}`);
    }
  }
  console.log(`→ ${allShotRows.length} shots to insert (${unmatchedPlayers} unresolved player references skipped)`);

  // 4. Bulk insert in chunks (24 cols × 1500 rows = 36k params, well under
  //    the 65535 postgres limit). ON CONFLICT DO NOTHING by understat_id.
  const CHUNK = 1500;
  let inserted = 0;
  for (let i = 0; i < allShotRows.length; i += CHUNK) {
    const slice = allShotRows.slice(i, i + CHUNK);
    const res: any = await sql`
      INSERT INTO player_shot_history ${(sql as any)(slice,
        'understat_id', 'player_id', 'match_date',
        'team_id', 'opponent_team_id', 'is_home', 'minute',
        'xg', 'situation', 'shot_type', 'result',
        'x_loc', 'y_loc')}
      ON CONFLICT (understat_id) DO NOTHING
    `;
    inserted += Number(res?.count ?? slice.length);
  }
  console.log(`→ persisted shot rows (chunked).`);

  // 5. Refresh per-player aggregates. Single SQL pass.
  await sql`TRUNCATE player_shot_aggregates`;
  await sql`
    INSERT INTO player_shot_aggregates (
      player_id,
      shots_open_play, shots_set_piece, shots_penalty, shots_direct_fk,
      xg_open_play,    xg_set_piece,    xg_penalty,    xg_direct_fk,
      goals_open_play, goals_set_piece, goals_penalty, goals_direct_fk,
      last_match_date, updated_at
    )
    SELECT
      player_id,
      COUNT(*) FILTER (WHERE situation IN ('OpenPlay'))                              AS shots_open_play,
      COUNT(*) FILTER (WHERE situation IN ('FromCorner','SetPiece'))                  AS shots_set_piece,
      COUNT(*) FILTER (WHERE situation IN ('Penalty'))                                AS shots_penalty,
      COUNT(*) FILTER (WHERE situation IN ('DirectFreekick'))                         AS shots_direct_fk,
      COALESCE(SUM(xg) FILTER (WHERE situation IN ('OpenPlay')), 0)::numeric          AS xg_open_play,
      COALESCE(SUM(xg) FILTER (WHERE situation IN ('FromCorner','SetPiece')), 0)::numeric AS xg_set_piece,
      COALESCE(SUM(xg) FILTER (WHERE situation IN ('Penalty')), 0)::numeric           AS xg_penalty,
      COALESCE(SUM(xg) FILTER (WHERE situation IN ('DirectFreekick')), 0)::numeric    AS xg_direct_fk,
      COUNT(*) FILTER (WHERE result = 'Goal' AND situation = 'OpenPlay')              AS goals_open_play,
      COUNT(*) FILTER (WHERE result = 'Goal' AND situation IN ('FromCorner','SetPiece')) AS goals_set_piece,
      COUNT(*) FILTER (WHERE result = 'Goal' AND situation = 'Penalty')               AS goals_penalty,
      COUNT(*) FILTER (WHERE result = 'Goal' AND situation = 'DirectFreekick')        AS goals_direct_fk,
      MAX(match_date)                                                                 AS last_match_date,
      now()                                                                           AS updated_at
    FROM player_shot_history
    GROUP BY player_id
  `;
  const aggCount = await sql<Array<{ c: number }>>`SELECT COUNT(*)::int AS c FROM player_shot_aggregates`;
  console.log(`→ rebuilt aggregates for ${aggCount[0]?.c ?? 0} players`);

  // 6. Refresh team-level shots-against aggregates.
  await sql`TRUNCATE team_shot_aggregates`;
  await sql`
    INSERT INTO team_shot_aggregates (
      team_id, shots_against, xg_against,
      shots_against_open_play, xg_against_open_play, matches, updated_at
    )
    SELECT
      opponent_team_id AS team_id,
      COUNT(*)                                                                  AS shots_against,
      COALESCE(SUM(xg), 0)::numeric                                             AS xg_against,
      COUNT(*) FILTER (WHERE situation = 'OpenPlay')                            AS shots_against_open_play,
      COALESCE(SUM(xg) FILTER (WHERE situation = 'OpenPlay'), 0)::numeric        AS xg_against_open_play,
      COUNT(DISTINCT (match_date, team_id))                                     AS matches,
      now()
    FROM player_shot_history
    WHERE opponent_team_id IS NOT NULL
    GROUP BY opponent_team_id
  `;
  console.log(`done. ${inserted} new shot rows.`);
  await sql.end();
}

main().catch(err => { console.error(err); process.exit(1); });
