#!/usr/bin/env tsx
/**
 * Pull player goal-scorer odds from The Odds API for every upcoming EPL
 * fixture in the planning gameweek, fuzzy-match player names to our
 * players table, and upsert into market_odds.
 *
 * Required env: ODDS_API_KEY  (https://the-odds-api.com — free tier)
 *
 * Free-tier budget: ~500 reqs/month. This script makes 1 + N calls per
 * run (1 events listing + N event-detail calls). For 10 EPL fixtures
 * that's 11 calls. Run once or twice per gameweek.
 *
 * Idempotent: each captured_at gets a new row, so we keep a history of
 * how odds moved through the week — the ensemble uses market_odds_latest
 * which picks the freshest row per (player, market, gameweek).
 */
import { sql } from '../src/lib/db/client';
import {
  listEvents, eventPlayerGoalOdds,
  decimalToProb
} from '../src/lib/odds/the-odds-api';

async function main() {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.error(
      '✗ ODDS_API_KEY env var not set.\n' +
      '  Sign up free at https://the-odds-api.com and add the key to your\n' +
      '  shell or GitHub Actions secrets. Then re-run.'
    );
    process.exit(1);
  }

  // Resolve target gameweek (next un-deadlined).
  const gwRow = await sql<Array<{ id: number }>>`
    SELECT id FROM gameweeks
     WHERE deadline_time > now()
     ORDER BY deadline_time ASC
     LIMIT 1
  `;
  const targetGw = gwRow[0]?.id;
  if (!targetGw) {
    console.error('✗ No upcoming gameweek — season over.');
    process.exit(1);
  }
  console.log(`→ Targeting GW ${targetGw}`);

  // Build a team-name → team_id map for fixture matching. The Odds API
  // uses long names ("Manchester City"); our teams table uses short names
  // ("MCI") plus long names in .name. Match on the long form.
  const teams = await sql<Array<{ id: number; name: string; short_name: string }>>`
    SELECT id, name, short_name FROM teams
  `;
  const teamByName = new Map<string, number>();
  for (const t of teams) {
    teamByName.set(t.name.toLowerCase(), t.id);
    teamByName.set(t.short_name.toLowerCase(), t.id);
  }

  // Player web_name → player_id map for player matching. Odds API returns
  // names like "Erling Haaland"; we match on last word against web_name
  // first, full name fallback. Same logic as the YouTube extractor.
  const players = await sql<Array<{
    id: number; web_name: string; first_name: string; second_name: string; team_id: number;
  }>>`
    SELECT id, web_name, first_name, second_name, team_id
      FROM players WHERE status <> 'u'
  `;
  const playerByKey = new Map<string, number>();
  for (const p of players) {
    const last = (p.second_name.split(/\s+/).pop() ?? p.web_name).toLowerCase();
    playerByKey.set(last, p.id);
    playerByKey.set(`${p.first_name.toLowerCase()} ${p.second_name.toLowerCase()}`, p.id);
    playerByKey.set(p.web_name.toLowerCase(), p.id);
  }
  const resolvePlayer = (apiName: string): number | null => {
    const k = apiName.trim().toLowerCase();
    if (playerByKey.has(k)) return playerByKey.get(k)!;
    // Try last word
    const last = k.split(/\s+/).pop() ?? '';
    if (playerByKey.has(last)) return playerByKey.get(last)!;
    return null;
  };

  // 1. List events.
  const events = await listEvents(apiKey);
  console.log(`→ ${events.length} EPL events from odds API`);
  // We don't strictly know which events fall in our GW window — the API
  // returns all upcoming. We pull all of them and tag by gameweek_id
  // based on the team-pair matching our fixtures table.
  const targetFixtures = await sql<Array<{
    id: number; team_h: number; team_a: number;
    home_name: string; away_name: string;
  }>>`
    SELECT f.id, f.team_h, f.team_a,
           th.name AS home_name, ta.name AS away_name
      FROM fixtures f
      JOIN teams th ON th.id = f.team_h
      JOIN teams ta ON ta.id = f.team_a
     WHERE f.gameweek_id = ${targetGw}
  `;
  const fixtureByPair = new Map<string, { fixtureId: number; teamH: number; teamA: number }>();
  for (const f of targetFixtures) {
    fixtureByPair.set(
      `${f.home_name.toLowerCase()}|${f.away_name.toLowerCase()}`,
      { fixtureId: f.id, teamH: f.team_h, teamA: f.team_a }
    );
  }

  // 2. For each event that matches a GW fixture, pull player-goalscorer odds.
  const rowsToInsert: any[] = [];
  let matched = 0;
  let skipped = 0;
  for (const ev of events) {
    const key = `${ev.home_team.toLowerCase()}|${ev.away_team.toLowerCase()}`;
    const fix = fixtureByPair.get(key);
    if (!fix) { skipped++; continue; }
    matched++;
    try {
      const odds = await eventPlayerGoalOdds(apiKey, ev.id);
      for (const o of odds) {
        const playerId = resolvePlayer(o.playerName);
        if (!playerId) continue;
        // Implied prob from mean decimal. We DON'T de-vig here because the
        // anytime-scorer market spans many outcomes (every player on the
        // pitch); over-round is harder to compute cleanly. Naive 1/odds is
        // close enough for our purposes.
        const prob = decimalToProb(o.decimalOdds);
        rowsToInsert.push({
          gameweek_id: targetGw,
          fixture_id: fix.fixtureId,
          market: 'player_goal',
          player_id: playerId,
          team_id: null,
          decimal_odds: Number(o.decimalOdds.toFixed(3)),
          implied_prob: Number(prob.toFixed(4)),
          market_overround: null,
          bookmaker: 'consensus',
          source: `the-odds-api/${o.bookmakers.length}-books`
        });
      }
    } catch (err) {
      console.warn(`  ${ev.home_team} vs ${ev.away_team}: ${(err as Error).message}`);
    }
  }
  console.log(`→ matched ${matched} events, skipped ${skipped}; ${rowsToInsert.length} player-goal rows`);

  if (rowsToInsert.length === 0) {
    console.log('done. Nothing to insert.');
    await sql.end();
    return;
  }

  // 3. Bulk insert.
  await sql`
    INSERT INTO market_odds ${(sql as any)(rowsToInsert,
      'gameweek_id', 'fixture_id', 'market', 'player_id', 'team_id',
      'decimal_odds', 'implied_prob', 'market_overround', 'bookmaker', 'source')}
  `;
  console.log(`done. Inserted ${rowsToInsert.length} rows.`);
  await sql.end();
}

main().catch(err => { console.error(err); process.exit(1); });
