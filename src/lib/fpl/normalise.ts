import { sql, json } from '@/lib/db/client';
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

/**
 * Bulk-INSERT version of upsertBootstrap. The postgres.js multi-row VALUES
 * syntax lets us insert 700 players in a single round-trip instead of 700.
 * Same pattern for teams + events. Total: 3 round-trips instead of 758.
 */
export async function upsertBootstrap(bs: FplBootstrap) {
  // Teams: single bulk INSERT with ON CONFLICT DO UPDATE.
  const teamRows = bs.teams.map(t => ({
    id: t.id,
    code: t.code,
    name: t.name,
    short_name: t.short_name,
    strength: t.strength,
    strength_home: t.strength_overall_home,
    strength_away: t.strength_overall_away,
    strength_attack_home: t.strength_attack_home,
    strength_attack_away: t.strength_attack_away,
    strength_def_home: t.strength_defence_home,
    strength_def_away: t.strength_defence_away,
    updated_at: new Date()
  }));
  await sql`
    INSERT INTO teams ${sql(teamRows,
      'id', 'code', 'name', 'short_name', 'strength',
      'strength_home', 'strength_away',
      'strength_attack_home', 'strength_attack_away',
      'strength_def_home', 'strength_def_away', 'updated_at')}
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

  // Gameweeks
  const eventRows = bs.events.map(e => ({
    id: e.id,
    name: e.name,
    deadline_time: e.deadline_time,
    is_current: e.is_current,
    is_next: e.is_next,
    is_previous: e.is_previous,
    finished: e.finished,
    data_checked: e.data_checked,
    average_entry_score: e.average_entry_score ?? null,
    highest_score: e.highest_score ?? null,
    chip_plays: e.chip_plays ?? [],
    most_captained: e.most_captained ?? null,
    most_vice_captained: e.most_vice_captained ?? null,
    most_selected: e.most_selected ?? null,
    most_transferred_in: e.most_transferred_in ?? null,
    top_element: e.top_element ?? null,
    top_element_info: e.top_element_info ?? null
  }));
  await sql`
    INSERT INTO gameweeks ${(sql as any)(eventRows,
      'id', 'name', 'deadline_time', 'is_current', 'is_next', 'is_previous',
      'finished', 'data_checked', 'average_entry_score', 'highest_score',
      'chip_plays', 'most_captained', 'most_vice_captained', 'most_selected',
      'most_transferred_in', 'top_element', 'top_element_info')}
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

  // Players — bulk insert + capture status snapshots in one go.
  const playerRows = bs.elements
    .filter(p => POSITION_MAP[p.element_type])
    .map(p => ({
      id: p.id,
      code: p.code,
      team_id: p.team,
      position: POSITION_MAP[p.element_type]!,
      first_name: p.first_name,
      second_name: p.second_name,
      web_name: p.web_name,
      now_cost: p.now_cost,
      status: p.status,
      news: p.news || null,
      news_added_at: p.news_added ?? null,
      chance_of_playing_next_round: p.chance_of_playing_next_round,
      chance_of_playing_this_round: p.chance_of_playing_this_round,
      selected_by_percent: Number(p.selected_by_percent) || 0,
      transfers_in_event: p.transfers_in_event,
      transfers_out_event: p.transfers_out_event,
      updated_at: new Date()
    }));
  await sql`
    INSERT INTO players ${sql(playerRows,
      'id', 'code', 'team_id', 'position', 'first_name', 'second_name', 'web_name',
      'now_cost', 'status', 'news', 'news_added_at',
      'chance_of_playing_next_round', 'chance_of_playing_this_round',
      'selected_by_percent', 'transfers_in_event', 'transfers_out_event', 'updated_at')}
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

  // Injury history — one bulk insert. (No conflict — append-only audit log.)
  const injuryRows = bs.elements.map(p => ({
    player_id: p.id,
    status: p.status,
    chance_of_playing_next: p.chance_of_playing_next_round,
    news: p.news || null
  }));
  await sql`
    INSERT INTO injury_status_history ${sql(injuryRows,
      'player_id', 'status', 'chance_of_playing_next', 'news')}
  `;
}

/** Bulk-insert fixtures: 380 rows in one round-trip. */
export async function upsertFixtures(rows: FplFixture[]) {
  if (rows.length === 0) return;
  const records = rows.map(f => ({
    id: f.id,
    gameweek_id: f.event,
    kickoff_time: f.kickoff_time,
    team_h: f.team_h,
    team_a: f.team_a,
    team_h_difficulty: f.team_h_difficulty,
    team_a_difficulty: f.team_a_difficulty,
    team_h_score: f.team_h_score,
    team_a_score: f.team_a_score,
    finished: f.finished,
    started: f.started,
    minutes: f.minutes,
    stats: f.stats ?? [],
    updated_at: new Date()
  }));
  await sql`
    INSERT INTO fixtures ${(sql as any)(records,
      'id', 'gameweek_id', 'kickoff_time', 'team_h', 'team_a',
      'team_h_difficulty', 'team_a_difficulty', 'team_h_score', 'team_a_score',
      'finished', 'started', 'minutes', 'stats', 'updated_at')}
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

/**
 * Bulk-write live event data. Builds a (player, fixture) row per active
 * element and inserts them all at once.
 */
export async function upsertEventLive(gw: number, live: FplEventLive) {
  // For each element, derive its fixture from the first explain entry.
  const rows: any[] = [];
  for (const el of live.elements) {
    const fixtures = (el.explain ?? []).map(e => e.fixture);
    if (fixtures.length === 0) continue;
    const fixtureId = fixtures[0]!;
    const s = el.stats;
    rows.push({
      player_id: el.id,
      gameweek_id: gw,
      fixture_id: fixtureId,
      opponent_team: null,    // resolved below via JOIN if needed; nullable in schema
      was_home: null,
      minutes: s.minutes,
      goals_scored: s.goals_scored,
      assists: s.assists,
      clean_sheets: s.clean_sheets,
      goals_conceded: s.goals_conceded,
      own_goals: s.own_goals,
      penalties_saved: s.penalties_saved,
      penalties_missed: s.penalties_missed,
      yellow_cards: s.yellow_cards,
      red_cards: s.red_cards,
      saves: s.saves,
      bonus: s.bonus,
      bps: s.bps,
      expected_goals: Number(s.expected_goals) || 0,
      expected_assists: Number(s.expected_assists) || 0,
      expected_goal_involvements: Number(s.expected_goal_involvements) || 0,
      expected_goals_conceded: Number(s.expected_goals_conceded) || 0,
      total_points: s.total_points,
      starts: s.starts
    });
  }
  if (rows.length === 0) return;
  await sql`
    INSERT INTO player_gameweek_history ${(sql as any)(rows,
      'player_id', 'gameweek_id', 'fixture_id', 'opponent_team', 'was_home',
      'minutes', 'goals_scored', 'assists', 'clean_sheets', 'goals_conceded',
      'own_goals', 'penalties_saved', 'penalties_missed', 'yellow_cards', 'red_cards',
      'saves', 'bonus', 'bps', 'expected_goals', 'expected_assists',
      'expected_goal_involvements', 'expected_goals_conceded', 'total_points', 'starts')}
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
  // Backfill opponent_team + was_home in one query using the fixtures table.
  await sql`
    UPDATE player_gameweek_history pgh
    SET opponent_team = CASE WHEN f.team_h = p.team_id THEN f.team_a ELSE f.team_h END,
        was_home      = (f.team_h = p.team_id)
    FROM players p, fixtures f
    WHERE pgh.player_id = p.id
      AND pgh.fixture_id = f.id
      AND pgh.gameweek_id = ${gw}
      AND pgh.opponent_team IS NULL
  `;
}

/**
 * Persist all classic + h2h leagues a manager belongs to. Pulled from the
 * `/entry/{id}/` endpoint which includes a `leagues` block. Idempotent.
 */
export async function upsertManagerLeagues(managerId: number, entry: FplManagerEntry) {
  const classic = entry.leagues?.classic ?? [];
  const h2h     = entry.leagues?.h2h ?? [];
  const all     = [
    ...classic.map(l => ({ ...l, scoring: 'c' as const })),
    ...h2h.map(l => ({ ...l, scoring: 'h' as const }))
  ];
  if (all.length === 0) return;

  const rows = all.map(l => ({
    manager_id: managerId,
    league_id: l.id,
    name: l.name,
    short_name: l.short_name ?? null,
    scoring: l.scoring,
    league_type: l.league_type ?? 'x',
    start_event: l.start_event ?? null,
    entry_rank: l.entry_rank ?? null,
    entry_last_rank: l.entry_last_rank ?? null,
    entry_percentile_rank: l.entry_percentile_rank ?? null,
    closed: !!l.closed,
    updated_at: new Date()
  }));
  await sql`
    INSERT INTO manager_leagues ${sql(rows,
      'manager_id', 'league_id', 'name', 'short_name', 'scoring', 'league_type',
      'start_event', 'entry_rank', 'entry_last_rank', 'entry_percentile_rank',
      'closed', 'updated_at')}
    ON CONFLICT (manager_id, league_id) DO UPDATE SET
      name = EXCLUDED.name,
      short_name = EXCLUDED.short_name,
      league_type = EXCLUDED.league_type,
      entry_rank = EXCLUDED.entry_rank,
      entry_last_rank = EXCLUDED.entry_last_rank,
      entry_percentile_rank = EXCLUDED.entry_percentile_rank,
      closed = EXCLUDED.closed,
      updated_at = now()
  `;
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
  if (picks.picks.length === 0) return;
  const rows = picks.picks.map(p => ({
    manager_id: managerId,
    gameweek_id: gw,
    player_id: p.element,
    position: p.position,
    is_captain: p.is_captain,
    is_vice: p.is_vice_captain,
    multiplier: p.multiplier,
    purchase_price: p.purchase_price ?? null,
    selling_price: p.selling_price ?? null
  }));
  await sql`
    INSERT INTO manager_picks ${sql(rows,
      'manager_id', 'gameweek_id', 'player_id', 'position',
      'is_captain', 'is_vice', 'multiplier', 'purchase_price', 'selling_price')}
    ON CONFLICT DO NOTHING
  `;
}

export async function upsertClassicLeague(league: FplClassicLeague, gw: number) {
  if (league.standings.results.length === 0) return;
  const rows = league.standings.results.map(r => ({
    league_id: league.league.id,
    gameweek_id: gw,
    rank: r.rank,
    last_rank: r.last_rank,
    entry: r.entry,
    entry_name: r.entry_name,
    player_name: r.player_name,
    total: r.total,
    event_total: r.event_total,
    snapshot_at: new Date()
  }));
  await sql`
    INSERT INTO classic_league_standings ${sql(rows,
      'league_id', 'gameweek_id', 'rank', 'last_rank',
      'entry', 'entry_name', 'player_name', 'total', 'event_total', 'snapshot_at')}
    ON CONFLICT DO NOTHING
  `;
}
