#!/usr/bin/env tsx
/**
 * Player X-ray: show every input the projection engine used for a given
 * player + gameweek. Useful for auditing the gap between our model and
 * an external reference (e.g. FPLReview).
 *
 *   npm run player:xray -- Bowen
 *   npm run player:xray -- "J.Bowen"
 *   GW=38 npm run player:xray -- Haaland
 *
 * Outputs: team attack/defence, opp ratings, Understat shot data,
 * minutes projection, baselines, hierarchical estimates, and the final
 * xpts_total + breakdown.
 */
import { sql } from '../src/lib/db/client';

async function main() {
  const arg = process.argv.slice(2).join(' ').trim();
  if (!arg) {
    console.error('Usage: npm run player:xray -- <player name>');
    process.exit(1);
  }
  const gwArg = process.env.GW ? Number(process.env.GW) : null;

  // Resolve gameweek.
  const gwRow = gwArg
    ? await sql<Array<{ id: number; name: string }>>`SELECT id, name FROM gameweeks WHERE id = ${gwArg}`
    : await sql<Array<{ id: number; name: string }>>`
        SELECT id, name FROM gameweeks
         WHERE is_next = TRUE OR is_current = TRUE
         ORDER BY is_next DESC, is_current DESC LIMIT 1
      `;
  const gw = gwRow[0];
  if (!gw) { console.error('No gameweek found'); process.exit(1); }

  // Resolve player by fuzzy name (web_name, second_name, full_name).
  const players = await sql<Array<{
    id: number; web_name: string; first_name: string; second_name: string;
    position: 'GKP'|'DEF'|'MID'|'FWD'; team_id: number; status: string;
    now_cost: number; chance_of_playing_next_round: number | null;
    season_minutes: number; season_xg: number; season_xa: number;
    season_bonus: number; season_defcon_per_90: number;
  }>>`
    SELECT id, web_name, first_name, second_name, position, team_id, status,
           now_cost, chance_of_playing_next_round,
           COALESCE(season_minutes, 0) AS season_minutes,
           COALESCE(season_xg, 0) AS season_xg,
           COALESCE(season_xa, 0) AS season_xa,
           COALESCE(season_bonus, 0) AS season_bonus,
           COALESCE(season_defcon_per_90, 0) AS season_defcon_per_90
      FROM players
     WHERE LOWER(web_name)    LIKE ${`%${arg.toLowerCase()}%`}
        OR LOWER(second_name) LIKE ${`%${arg.toLowerCase()}%`}
        OR LOWER(first_name || ' ' || second_name) LIKE ${`%${arg.toLowerCase()}%`}
     LIMIT 5
  `;
  if (players.length === 0) {
    console.error(`No player matched "${arg}"`);
    process.exit(1);
  }
  if (players.length > 1) {
    console.log(`Multiple matches:`);
    for (const p of players) console.log(`  - ${p.web_name} (${p.first_name} ${p.second_name}) #${p.id}`);
    console.log('Refine the name and re-run.');
    process.exit(0);
  }
  const p = players[0]!;

  // Team strengths
  const teamRow = await sql<Array<{
    id: number; name: string; short_name: string;
    attacking_style: number; defensive_solidity: number;
  }>>`
    SELECT id, name, short_name,
           COALESCE(attacking_style, 1.0)::float8    AS attacking_style,
           COALESCE(defensive_solidity, 1.0)::float8 AS defensive_solidity
      FROM teams WHERE id = ${p.team_id}
  `;
  const team = teamRow[0]!;

  // Fixture
  const fixRows = await sql<Array<{
    id: number; team_h: number; team_a: number;
    home_name: string; away_name: string;
    home_attack: number; home_defence: number;
    away_attack: number; away_defence: number;
  }>>`
    SELECT f.id, f.team_h, f.team_a,
           th.name AS home_name, ta.name AS away_name,
           th.attacking_style::float8    AS home_attack,
           th.defensive_solidity::float8 AS home_defence,
           ta.attacking_style::float8    AS away_attack,
           ta.defensive_solidity::float8 AS away_defence
      FROM fixtures f
      JOIN teams th ON th.id = f.team_h
      JOIN teams ta ON ta.id = f.team_a
     WHERE f.event = ${gw.id}
       AND (f.team_h = ${p.team_id} OR f.team_a = ${p.team_id})
  `;

  // Understat aggregates
  const shotRow = await sql<Array<{
    shots_open_play: number; shots_penalty: number;
    xg_open_play: number; xg_penalty: number;
    goals_open_play: number; goals_penalty: number;
    last_match_date: Date | null;
  }>>`
    SELECT shots_open_play::int, shots_penalty::int,
           xg_open_play::float8, xg_penalty::float8,
           goals_open_play::int, goals_penalty::int,
           last_match_date
      FROM player_shot_aggregates WHERE player_id = ${p.id}
  `;

  // Minutes projection
  const minsRows = await sql<Array<{
    fixture_id: number; start_prob: number; sixty_plus_prob: number;
    expected_minutes: number; rotation_risk: number;
    reasons: any;
  }>>`
    SELECT fixture_id, start_prob::float8, sixty_plus_prob::float8,
           expected_minutes::float8, rotation_risk::float8, reasons
      FROM minutes_projections
     WHERE player_id = ${p.id}
       AND fixture_id IN (SELECT id FROM fixtures WHERE event = ${gw.id})
  `;

  // Projection output
  const projRows = await sql<Array<{
    fixture_id: number; xpts_total: number;
    xpts_appearance: number; xpts_goals: number; xpts_assists: number;
    xpts_clean_sheet: number; xpts_bonus: number; xpts_defcon: number;
    floor: number; ceiling: number; reasons: any;
  }>>`
    SELECT fixture_id, xpts_total::float8,
           xpts_appearance::float8, xpts_goals::float8, xpts_assists::float8,
           xpts_clean_sheet::float8, xpts_bonus::float8, xpts_defcon::float8,
           floor::float8, ceiling::float8, reasons
      FROM projections
     WHERE player_id = ${p.id} AND gameweek_id = ${gw.id}
  `;

  // Hierarchical estimate (if the table exists)
  let hierRow: any[] = [];
  try {
    hierRow = await sql`
      SELECT xg90::float8, xa90::float8, bonus90::float8, own_weight::float8
        FROM player_hierarchical_estimates WHERE player_id = ${p.id}
    `;
  } catch {/* table may not exist yet */}

  console.log('');
  console.log(`╔ ${p.web_name}  (${p.first_name} ${p.second_name})`);
  console.log(`║ #${p.id} · ${p.position} · ${team.short_name} · £${(p.now_cost/10).toFixed(1)}m · status="${p.status}"`);
  console.log(`║ chance_of_playing_next_round=${p.chance_of_playing_next_round ?? 'null'}`);
  console.log('╠ Season totals');
  console.log(`║ minutes=${p.season_minutes}  xG=${Number(p.season_xg).toFixed(2)}  xA=${Number(p.season_xa).toFixed(2)}  bonus=${p.season_bonus}  defcon/90=${Number(p.season_defcon_per_90).toFixed(1)}`);
  console.log('╠ Team ratings (after Bayesian recompute)');
  console.log(`║ ${team.name} attack=${team.attacking_style.toFixed(3)}  defence=${team.defensive_solidity.toFixed(3)} (higher=better defence)`);
  console.log('╠ GW' + gw.id + ' fixture');
  for (const f of fixRows) {
    const isHome = f.team_h === p.team_id;
    const opp = isHome ? { name: f.away_name, attack: f.away_attack, defence: f.away_defence }
                       : { name: f.home_name, attack: f.home_attack, defence: f.home_defence };
    console.log(`║ ${isHome ? 'vs' : '@'} ${opp.name}  opp_attack=${opp.attack.toFixed(3)} opp_defence=${opp.defence.toFixed(3)}`);
  }
  console.log('╠ Understat shot aggregates');
  if (shotRow.length === 0) {
    console.log('║ ⚠️  Not in player_shot_aggregates! Engine falls back to season_xg heuristic.');
    console.log('║ This is the most common cause of an UNDER-rated forward.');
  } else {
    const s = shotRow[0]!;
    console.log(`║ open_play shots=${s.shots_open_play} xG=${Number(s.xg_open_play).toFixed(2)} goals=${s.goals_open_play}`);
    console.log(`║ penalties shots=${s.shots_penalty} xG=${Number(s.xg_penalty).toFixed(2)} goals=${s.goals_penalty}`);
    console.log(`║ last match: ${s.last_match_date}`);
  }
  console.log('╠ Hierarchical estimates');
  if (hierRow.length === 0) {
    console.log('║ Not computed (run recompute:all to populate).');
  } else {
    const h = hierRow[0]!;
    console.log(`║ xG/90=${Number(h.xg90).toFixed(2)}  xA/90=${Number(h.xa90).toFixed(2)}  bonus/90=${Number(h.bonus90).toFixed(2)}  own_weight=${(Number(h.own_weight)*100).toFixed(0)}%`);
  }
  console.log('╠ Minutes projection');
  for (const m of minsRows) {
    console.log(`║ start=${(m.start_prob*100).toFixed(0)}% 60+=${(m.sixty_plus_prob*100).toFixed(0)}% expected_mins=${m.expected_minutes.toFixed(1)} rotation_risk=${(m.rotation_risk*100).toFixed(0)}%`);
  }
  console.log('╠ Projection breakdown');
  if (projRows.length === 0) {
    console.log('║ ⚠️  No projection row for this GW!');
  } else {
    for (const pr of projRows) {
      console.log(`║ xpts_total=${pr.xpts_total.toFixed(2)}`);
      console.log(`║   appearance=${pr.xpts_appearance.toFixed(2)}  goals=${pr.xpts_goals.toFixed(2)}  assists=${pr.xpts_assists.toFixed(2)}`);
      console.log(`║   clean_sheet=${pr.xpts_clean_sheet.toFixed(2)}  bonus=${pr.xpts_bonus.toFixed(2)}  defcon=${pr.xpts_defcon.toFixed(2)}`);
      console.log(`║   floor=${pr.floor.toFixed(2)}  ceiling=${pr.ceiling.toFixed(2)}`);
      if (Array.isArray(pr.reasons)) {
        console.log('║   reasons:');
        for (const r of pr.reasons.slice(0, 10)) {
          console.log(`║     - ${r.kind ?? '?'}: ${r.detail ?? JSON.stringify(r)}`);
        }
      }
    }
  }
  console.log('╚');
  await sql.end({ timeout: 5 });
}

main().catch(err => { console.error(err); process.exit(1); });
