import { sql } from '@/lib/db/client';
import type {
  FplBootstrap,
  FplElement,
  FplFixture,
  FplManagerEntry,
  FplManagerPicks,
  FplClassicLeague,
  FplEventLive
} from './types';

const POSITION_MAP: Record<number, 'GKP' | 'DEF' | 'MID' | 'FWD'> = {
  1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD'
};

export async function upsertBootstrap(bs: FplBootstrap) {
  // Teams
  for (const t of bs.teams) {
    await sql`
      INSERT INTO teams (id, code, name, short_name, strength,
                         strength_home, strength_away,
                         strength_attack_home, strength_attack_away,
                         strength_def_home,    strength_def_away,
                         updated_at)
      VALUES (${t.id}, ${t.code}, ${t.name}, ${t.short_name}, ${t.strength},
              ${t.strength_overall_home}, ${t.strength_overall_away},
              ${t.strength_attack_home}, ${t.strength_attack_away},
              ${t.strength_defence_home}, ${t.strength_defence_away},
              now())
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        short_name = EXCLUDED.short_name,
        strength = EXCLUDED.strength,
        strength_home = EXCLUDED.strength_home,
        strength_away = EXCLUDED.strength_away,
        strength_attack_home = EXCLUDED.strength_attack_home,
        strength_attack_away = EXCLUDED.strength_attack_away,
        strength_def_home = EXCLUDED.strength_def_home,
        strength_def_away = EXCLUDED.strength_def_away,
        updated_at = now()
    `;
  }

  // Gameweeks
  for (const e of bs.events) {
    await sql`
      INSERT INTO gameweeks (id, name, deadline_time, is_current, is_next, is_previous,
                             finished, data_checked, average_entry_score, highest_score,
                             chip_plays, most_captained, most_vice_captained, most_selected,
                             most_transferred_in, top_element, top_element_info)
      VALUES (${e.id}, ${e.name}, ${e.deadline_time}, ${e.is_current}, ${e.is_next},
              ${e.is_previous}, ${e.finished}, ${e.data_checked},
              ${e.average_entry_score ?? null}, ${e.highest_score ?? null},
              ${sql.json(e.chip_plays ?? [])}, ${e.most_captained ?? null},
              ${e.most_vice_captained ?? null}, ${e.most_selected ?? null},
              ${e.most_transferred_in ?? null}, ${e.top_element ?? null},
              ${sql.json(e.top_element_info ?? null)})
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        deadline_time = EXCLUDED.deadline_time,
        is_current = EXCLUDED.is_current,
        is_next = EXCLUDED.is_next,
        is_previous = EXCLUDED.is_previous,
        finished = EXCLUDED.finished,
        data_checked = EXCLUDED.data_checked,
        average_entry_score = EXCLUDED.average_entry_score,
        highest_score = EXCLUDED.highest_score,
        chip_plays = EXCLUDED.chip_plays,
        most_captained = EXCLUDED.most_captained,
        most_vice_captained = EXCLUDED.most_vice_captained,
        most_selected = EXCLUDED.most_selected,
        most_transferred_in = EXCLUDED.most_transferred_in,
        top_element = EXCLUDED.top_element,
        top_element_info = EXCLUDED.top_element_info
    `;
  }

  // Players
  for (const p of bs.elements) {
    await upsertPlayer(p);
  }
}

async function upsertPlayer(p: FplElement) {
  const pos = POSITION_MAP[p.element_type];
  if (!pos) return;
  await sql`
    INSERT INTO players (id, code, team_id, position, first_name, second_name, web_name,
                         now_cost, status, news, news_added_at,
                         chance_of_playing_next_round, chance_of_playing_this_round,
                         selected_by_percent, transfers_in_event, transfers_out_event,
                         updated_at)
    VALUES (${p.id}, ${p.code}, ${p.team}, ${pos}, ${p.first_name}, ${p.second_name},
            ${p.web_name}, ${p.now_cost}, ${p.status}, ${p.news || null},
            ${p.news_added ?? null},
            ${p.chance_of_playing_next_round}, ${p.chance_of_playing_this_round},
            ${Number(p.selected_by_percent) || 0},
            ${p.transfers_in_event}, ${p.transfers_out_event}, now())
    ON CONFLICT (id) DO UPDATE SET
      team_id = EXCLUDED.team_id,
      position = EXCLUDED.position,
      first_name = EXCLUDED.first_name,
      second_name = EXCLUDED.second_name,
      web_name = EXCLUDED.web_name,
      now_cost = EXCLUDED.now_cost,
      status = EXCLUDED.status,
      news = EXCLUDED.news,
      news_added_at = EXCLUDED.news_added_at,
      chance_of_playing_next_round = EXCLUDED.chance_of_playing_next_round,
      chance_of_playing_this_round = EXCLUDED.chance_of_playing_this_round,
      selected_by_percent = EXCLUDED.selected_by_percent,
      transfers_in_event = EXCLUDED.transfers_in_event,
      transfers_out_event = EXCLUDED.transfers_out_event,
      updated_at = now()
  `;
  // Track injury status separately for return-from-injury rules
  await sql`
    INSERT INTO injury_status_history (player_id, status, chance_of_playing_next, news)
    VALUES (${p.id}, ${p.status}, ${p.chance_of_playing_next_round}, ${p.news || null})
  `;
}

export async function upsertFixtures(rows: FplFixture[]) {
  for (const f of rows) {
    await sql`
      INSERT INTO fixtures (id, gameweek_id, kickoff_time, team_h, team_a,
                            team_h_difficulty, team_a_difficulty,
                            team_h_score, team_a_score, finished, started, minutes, stats,
                            updated_at)
      VALUES (${f.id}, ${f.event}, ${f.kickoff_time}, ${f.team_h}, ${f.team_a},
              ${f.team_h_difficulty}, ${f.team_a_difficulty},
              ${f.team_h_score}, ${f.team_a_score}, ${f.finished}, ${f.started},
              ${f.minutes}, ${sql.json((f.stats ?? []) as any)}, now())
      ON CONFLICT (id) DO UPDATE SET
        gameweek_id = EXCLUDED.gameweek_id,
        kickoff_time = EXCLUDED.kickoff_time,
        team_h_difficulty = EXCLUDED.team_h_difficulty,
        team_a_difficulty = EXCLUDED.team_a_difficulty,
        team_h_score = EXCLUDED.team_h_score,
        team_a_score = EXCLUDED.team_a_score,
        finished = EXCLUDED.finished,
        started = EXCLUDED.started,
        minutes = EXCLUDED.minutes,
        stats = EXCLUDED.stats,
        updated_at = now()
    `;
  }
}

export async function upsertEventLive(gw: number, live: FplEventLive) {
  // Map each element's stats back to its fixture. The `explain` array lists
  // fixture-level breakdowns; we use the first explain entry as the fixture
  // attribution. (A player can technically appear in multiple fixtures in a
  // DGW — element-live splits this out via the explain[].fixture field.)
  for (const el of live.elements) {
    const fixtures = (el.explain ?? []).map(e => e.fixture);
    if (fixtures.length === 0) continue;
    const fixtureId = fixtures[0]!;
    const s = el.stats;
    await sql`
      INSERT INTO player_gameweek_history (
        player_id, gameweek_id, fixture_id, opponent_team, was_home, minutes,
        goals_scored, assists, clean_sheets, goals_conceded, own_goals,
        penalties_saved, penalties_missed, yellow_cards, red_cards, saves,
        bonus, bps, expected_goals, expected_assists, expected_goal_involvements,
        expected_goals_conceded, total_points, starts
      )
      SELECT ${el.id}, ${gw}, ${fixtureId},
             CASE WHEN f.team_h = p.team_id THEN f.team_a ELSE f.team_h END,
             (f.team_h = p.team_id),
             ${s.minutes}, ${s.goals_scored}, ${s.assists}, ${s.clean_sheets},
             ${s.goals_conceded}, ${s.own_goals}, ${s.penalties_saved},
             ${s.penalties_missed}, ${s.yellow_cards}, ${s.red_cards}, ${s.saves},
             ${s.bonus}, ${s.bps},
             ${Number(s.expected_goals) || 0},
             ${Number(s.expected_assists) || 0},
             ${Number(s.expected_goal_involvements) || 0},
             ${Number(s.expected_goals_conceded) || 0},
             ${s.total_points}, ${s.starts}
      FROM players p
      JOIN fixtures f ON f.id = ${fixtureId}
      WHERE p.id = ${el.id}
      ON CONFLICT (player_id, gameweek_id, fixture_id) DO UPDATE SET
        minutes = EXCLUDED.minutes,
        goals_scored = EXCLUDED.goals_scored,
        assists = EXCLUDED.assists,
        clean_sheets = EXCLUDED.clean_sheets,
        goals_conceded = EXCLUDED.goals_conceded,
        own_goals = EXCLUDED.own_goals,
        penalties_saved = EXCLUDED.penalties_saved,
        penalties_missed = EXCLUDED.penalties_missed,
        yellow_cards = EXCLUDED.yellow_cards,
        red_cards = EXCLUDED.red_cards,
        saves = EXCLUDED.saves,
        bonus = EXCLUDED.bonus,
        bps = EXCLUDED.bps,
        expected_goals = EXCLUDED.expected_goals,
        expected_assists = EXCLUDED.expected_assists,
        expected_goal_involvements = EXCLUDED.expected_goal_involvements,
        expected_goals_conceded = EXCLUDED.expected_goals_conceded,
        total_points = EXCLUDED.total_points,
        starts = EXCLUDED.starts
    `;
  }
}

export async function upsertManagerEntry(entry: FplManagerEntry, freeTransfers: number) {
  await sql`
    INSERT INTO manager_teams (manager_id, name, player_first_name, player_last_name,
                               favourite_team, total_points, overall_rank, bank, team_value,
                               free_transfers, last_deadline_total_transfers, updated_at)
    VALUES (${entry.id}, ${entry.name}, ${entry.player_first_name}, ${entry.player_last_name},
            ${entry.favourite_team}, ${entry.summary_overall_points}, ${entry.summary_overall_rank},
            ${entry.last_deadline_bank}, ${entry.last_deadline_value},
            ${freeTransfers}, ${entry.last_deadline_total_transfers}, now())
    ON CONFLICT (manager_id) DO UPDATE SET
      name = EXCLUDED.name,
      player_first_name = EXCLUDED.player_first_name,
      player_last_name = EXCLUDED.player_last_name,
      favourite_team = EXCLUDED.favourite_team,
      total_points = EXCLUDED.total_points,
      overall_rank = EXCLUDED.overall_rank,
      bank = EXCLUDED.bank,
      team_value = EXCLUDED.team_value,
      free_transfers = EXCLUDED.free_transfers,
      last_deadline_total_transfers = EXCLUDED.last_deadline_total_transfers,
      updated_at = now()
  `;
}

export async function upsertManagerPicks(managerId: number, gw: number, picks: FplManagerPicks) {
  await sql`DELETE FROM manager_picks WHERE manager_id = ${managerId} AND gameweek_id = ${gw}`;
  for (const p of picks.picks) {
    await sql`
      INSERT INTO manager_picks (manager_id, gameweek_id, player_id, position,
                                 is_captain, is_vice, multiplier, purchase_price, selling_price)
      VALUES (${managerId}, ${gw}, ${p.element}, ${p.position},
              ${p.is_captain}, ${p.is_vice_captain}, ${p.multiplier},
              ${p.purchase_price ?? null}, ${p.selling_price ?? null})
      ON CONFLICT DO NOTHING
    `;
  }
}

export async function upsertClassicLeague(league: FplClassicLeague, gw: number) {
  for (const r of league.standings.results) {
    await sql`
      INSERT INTO classic_league_standings (league_id, gameweek_id, rank, last_rank,
                                            entry, entry_name, player_name, total, event_total,
                                            snapshot_at)
      VALUES (${league.league.id}, ${gw}, ${r.rank}, ${r.last_rank},
              ${r.entry}, ${r.entry_name}, ${r.player_name}, ${r.total}, ${r.event_total}, now())
      ON CONFLICT DO NOTHING
    `;
  }
}
