#!/usr/bin/env tsx
/**
 * Confirmed-lineup ingest. Pulls the official lineups (released ~60min
 * before kick-off) and overrides start_prob in minutes_projections to
 * either 1.0 (confirmed start) or 0.0 (confirmed not-in-squad). Sub
 * benches are intermediate at 0.3.
 *
 * Source: FotMob's public-API match endpoint. We hit one endpoint per
 * fixture in the planning gameweek, which means ~10 requests per run.
 * FotMob's lineup JSON includes both starting XI and bench, so we can
 * cleanly bucket every player into one of three states.
 *
 *   Confirmed starter → start_prob = 1.0, sixty_plus_prob = 0.95
 *   Confirmed bench   → start_prob = 0.0, sub_prob = 0.30
 *   Not in squad      → start_prob = 0.0, bench_unused_prob = 1.0
 *
 * Run window: ideally between 60-15 minutes before deadline (FPL deadline
 * is 90min before first kickoff, but lineups drop 60min before kickoff,
 * so for the LAST set of fixtures the lineup info comes too late). For
 * the EARLY Saturday fixtures, this is gold.
 *
 * Idempotent: runs UPDATE on existing rows, doesn't insert duplicates.
 */
import { sql } from '../src/lib/db/client';

const FOTMOB_BASE = 'https://www.fotmob.com/api';

interface FotMobMatch {
  general: { matchId: string; homeTeam: { name: string }; awayTeam: { name: string } };
  content: {
    lineup?: {
      lineup: Array<{
        teamId: number;
        starters: Array<Array<{ id: number; name: { fullName: string } }>>;
        subs: Array<{ id: number; name: { fullName: string } }>;
      }>;
    };
    matchFacts?: { matchTimeUTC?: string };
  };
}

interface FotMobMatchListItem {
  matchId: number;
  status: { utcTime: string };
  home: { name: string };
  away: { name: string };
}

async function findFotMobMatchId(homeTeamName: string, awayTeamName: string, dateIso: string): Promise<number | null> {
  // FotMob's listing endpoint by date returns ALL matches on the day.
  // Filter to ours by team-name fuzzy match. The API has no key.
  const ymd = dateIso.slice(0, 10);
  const url = `${FOTMOB_BASE}/matches?date=${ymd}`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, cache: 'no-store' });
  if (!res.ok) return null;
  const data = await res.json() as { leagues?: Array<{ matches?: FotMobMatchListItem[] }> };
  const all: FotMobMatchListItem[] = [];
  for (const l of data.leagues ?? []) for (const m of l.matches ?? []) all.push(m);
  const lc = (s: string) => s.toLowerCase().trim();
  for (const m of all) {
    if (lc(m.home.name).includes(lc(homeTeamName).split(' ')[0]!) &&
        lc(m.away.name).includes(lc(awayTeamName).split(' ')[0]!)) {
      return m.matchId;
    }
  }
  return null;
}

async function fetchLineup(matchId: number): Promise<FotMobMatch | null> {
  const url = `${FOTMOB_BASE}/matchDetails?matchId=${matchId}`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, cache: 'no-store' });
  if (!res.ok) return null;
  return await res.json() as FotMobMatch;
}

async function main() {
  // Resolve the planning gameweek + its fixtures.
  const gwRow = await sql<Array<{ id: number; deadline_time: string }>>`
    SELECT id, deadline_time FROM gameweeks
     WHERE deadline_time > now()
     ORDER BY deadline_time ASC LIMIT 1
  `;
  const targetGw = gwRow[0]?.id;
  if (!targetGw) {
    console.error('✗ No upcoming gameweek.');
    process.exit(1);
  }

  const fixtures = await sql<Array<{
    id: number; team_h: number; team_a: number;
    home_name: string; away_name: string;
    kickoff_time: string | null;
  }>>`
    SELECT f.id, f.team_h, f.team_a,
           th.name AS home_name, ta.name AS away_name,
           f.kickoff_time
      FROM fixtures f
      JOIN teams th ON th.id = f.team_h
      JOIN teams ta ON ta.id = f.team_a
     WHERE f.gameweek_id = ${targetGw}
       AND f.finished = FALSE
     ORDER BY f.kickoff_time
  `;
  console.log(`→ GW ${targetGw}: ${fixtures.length} fixtures to check`);

  // FPL player name → id (we'll match starters/subs back to our players).
  const players = await sql<Array<{
    id: number; web_name: string; first_name: string; second_name: string; team_id: number;
  }>>`
    SELECT id, web_name, first_name, second_name, team_id
      FROM players WHERE status <> 'u'
  `;
  const playerByLast = new Map<string, number[]>();
  for (const p of players) {
    const last = (p.second_name.split(/\s+/).pop() ?? p.web_name).toLowerCase();
    if (!playerByLast.has(last)) playerByLast.set(last, []);
    playerByLast.get(last)!.push(p.id);
  }
  const resolvePlayer = (fullName: string, teamId: number): number | null => {
    const last = fullName.trim().toLowerCase().split(/\s+/).pop()!;
    const candidates = (playerByLast.get(last) ?? [])
      .map(id => players.find(p => p.id === id)!)
      .filter(p => p.team_id === teamId);
    if (candidates.length === 1) return candidates[0]!.id;
    if (candidates.length === 0) return null;
    // Ambiguous — match on first name too
    const first = fullName.split(/\s+/)[0]!.toLowerCase();
    const refined = candidates.filter(p => p.first_name.toLowerCase() === first);
    return refined[0]?.id ?? candidates[0]!.id;
  };

  let overrides = 0;
  for (const fix of fixtures) {
    if (!fix.kickoff_time) continue;
    try {
      const matchId = await findFotMobMatchId(fix.home_name, fix.away_name, fix.kickoff_time);
      if (!matchId) {
        console.log(`  ${fix.home_name} vs ${fix.away_name}: no FotMob match found`);
        continue;
      }
      const md = await fetchLineup(matchId);
      const lineup = md?.content?.lineup?.lineup;
      if (!lineup || lineup.length < 2) {
        console.log(`  ${fix.home_name} vs ${fix.away_name}: lineup not yet released`);
        continue;
      }
      // FotMob returns lineup[0] for home, lineup[1] for away.
      const homeTeamData = lineup[0]!;
      const awayTeamData = lineup[1]!;
      const homeStarters = homeTeamData.starters.flat().map(s => s.name.fullName);
      const awayStarters = awayTeamData.starters.flat().map(s => s.name.fullName);
      const homeSubs     = homeTeamData.subs.map(s => s.name.fullName);
      const awaySubs     = awayTeamData.subs.map(s => s.name.fullName);

      const overrideRows: Array<{ playerId: number; start: number; sub: number; benchUnused: number }> = [];
      for (const name of homeStarters) {
        const id = resolvePlayer(name, fix.team_h);
        if (id) overrideRows.push({ playerId: id, start: 1.0, sub: 0, benchUnused: 0 });
      }
      for (const name of awayStarters) {
        const id = resolvePlayer(name, fix.team_a);
        if (id) overrideRows.push({ playerId: id, start: 1.0, sub: 0, benchUnused: 0 });
      }
      for (const name of homeSubs) {
        const id = resolvePlayer(name, fix.team_h);
        if (id) overrideRows.push({ playerId: id, start: 0, sub: 0.30, benchUnused: 0.70 });
      }
      for (const name of awaySubs) {
        const id = resolvePlayer(name, fix.team_a);
        if (id) overrideRows.push({ playerId: id, start: 0, sub: 0.30, benchUnused: 0.70 });
      }

      // Apply overrides to minutes_projections for this fixture.
      for (const r of overrideRows) {
        await sql`
          UPDATE minutes_projections
             SET start_prob       = ${r.start},
                 sixty_plus_prob  = ${r.start * 0.95},
                 ninety_prob      = ${r.start * 0.80},
                 sub_prob         = ${r.sub},
                 bench_unused_prob = ${r.benchUnused},
                 expected_minutes = ${r.start * 88 + r.sub * 22},
                 minutes_confidence = 0.99
           WHERE player_id = ${r.playerId} AND fixture_id = ${fix.id}
        `;
        overrides++;
      }
      console.log(`  ${fix.home_name} vs ${fix.away_name}: ${overrideRows.length} players locked`);
    } catch (err) {
      console.warn(`  ${fix.home_name} vs ${fix.away_name}: ${(err as Error).message}`);
    }
  }
  console.log(`done. ${overrides} player overrides applied.`);
  console.log('NOTE: re-run `npm run db:seed` (or recompute:projections) to flow these into xpts.');
  await sql.end();
}

main().catch(err => { console.error(err); process.exit(1); });
