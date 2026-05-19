// Subset of the public FPL API shapes we actually read. We use Zod at the
// network boundary for safety but keep these TS types for ergonomics elsewhere.

export interface FplBootstrap {
  events: FplEvent[];
  teams: FplTeam[];
  elements: FplElement[];
  element_types: FplElementType[];
  total_players: number;
}

export interface FplEvent {
  id: number;
  name: string;
  deadline_time: string;
  is_current: boolean;
  is_next: boolean;
  is_previous: boolean;
  finished: boolean;
  data_checked: boolean;
  average_entry_score: number | null;
  highest_score: number | null;
  chip_plays: Array<{ chip_name: string; num_played: number }>;
  most_captained: number | null;
  most_vice_captained: number | null;
  most_selected: number | null;
  most_transferred_in: number | null;
  top_element: number | null;
  top_element_info: { id: number; points: number } | null;
}

export interface FplTeam {
  id: number;
  code: number;
  name: string;
  short_name: string;
  strength: number;
  strength_overall_home: number;
  strength_overall_away: number;
  strength_attack_home: number;
  strength_attack_away: number;
  strength_defence_home: number;
  strength_defence_away: number;
}

export interface FplElement {
  id: number;
  code: number;
  team: number;
  element_type: number;             // 1=GKP 2=DEF 3=MID 4=FWD
  first_name: string;
  second_name: string;
  web_name: string;
  now_cost: number;
  status: string;
  news: string;
  news_added: string | null;
  chance_of_playing_this_round: number | null;
  chance_of_playing_next_round: number | null;
  selected_by_percent: string;
  transfers_in_event: number;
  transfers_out_event: number;
  // Minutes / production fields used by baselines:
  minutes: number;
  starts: number;
  goals_scored: number;
  assists: number;
  expected_goals: string;
  expected_assists: string;
  expected_goal_involvements: string;
  expected_goals_conceded: string;
  bonus: number;
  yellow_cards: number;
  red_cards: number;
  saves: number;
  // 25/26 — defensive contributions (clearances+blocks+interceptions+
  // tackles+recoveries). New scoring rule: DEF +2pts at 10+, MID/FWD at 12+.
  defensive_contribution?: number;
  defensive_contribution_per_90?: string;
  // Set-piece + penalty order: 1 = first taker, 2 = second, etc.
  penalties_order?: number | null;
  corners_and_indirect_freekicks_order?: number | null;
  direct_freekicks_order?: number | null;
}

export interface FplElementType {
  id: number;
  singular_name_short: 'GKP' | 'DEF' | 'MID' | 'FWD';
}

export interface FplFixture {
  id: number;
  event: number | null;
  kickoff_time: string | null;
  team_h: number;
  team_a: number;
  team_h_difficulty: number;
  team_a_difficulty: number;
  team_h_score: number | null;
  team_a_score: number | null;
  finished: boolean;
  started: boolean;
  minutes: number;
  stats: unknown[];
}

export interface FplEventLive {
  elements: Array<{
    id: number;
    stats: {
      minutes: number;
      goals_scored: number;
      assists: number;
      clean_sheets: number;
      goals_conceded: number;
      own_goals: number;
      penalties_saved: number;
      penalties_missed: number;
      yellow_cards: number;
      red_cards: number;
      saves: number;
      bonus: number;
      bps: number;
      starts: number;
      expected_goals: string;
      expected_assists: string;
      expected_goal_involvements: string;
      expected_goals_conceded: string;
      total_points: number;
    };
    explain: Array<{ fixture: number; stats: unknown[] }>;
  }>;
}

export interface FplLeagueSummary {
  id: number;
  name: string;
  short_name: string | null;
  created: string;
  closed: boolean;
  rank: number | null;
  max_entries: number | null;
  league_type: 's' | 'x' | 'c';   // s=system, x=other, c=classic
  scoring: 'c' | 'h';             // c=classic, h=h2h
  admin_entry: number | null;
  start_event: number;
  entry_can_leave: boolean;
  entry_can_admin: boolean;
  entry_can_invite: boolean;
  has_cup: boolean;
  cup_league: number | null;
  cup_qualified: boolean | null;
  entry_rank: number | null;
  entry_last_rank: number | null;
  entry_percentile_rank: number | null;
}

export interface FplManagerEntry {
  id: number;
  player_first_name: string;
  player_last_name: string;
  name: string;
  favourite_team: number | null;
  summary_overall_points: number;
  summary_overall_rank: number | null;
  last_deadline_bank: number;
  last_deadline_value: number;
  last_deadline_total_transfers: number;
  leagues?: {
    classic?: FplLeagueSummary[];
    h2h?: FplLeagueSummary[];
    cup?: unknown;
  };
}

export interface FplManagerPicks {
  active_chip: string | null;
  picks: Array<{
    element: number;
    position: number;
    is_captain: boolean;
    is_vice_captain: boolean;
    multiplier: number;
    purchase_price?: number;
    selling_price?: number;
  }>;
  entry_history: {
    event: number;
    points: number;
    total_points: number;
    rank: number | null;
    overall_rank: number | null;
    event_transfers: number;
    event_transfers_cost: number;
    bank: number;
    value: number;
  };
}

export interface FplManagerTransfers {
  // FPL returns an array, not an object
}

/**
 * /element-summary/{element_id}/ — per-player season history. Each row in
 * `history` is one finished fixture; this is the FPL-public-API source for
 * "recent form" data because /bootstrap-static/ only gives season totals.
 */
export interface FplElementHistoryRow {
  element: number;
  fixture: number;
  opponent_team: number;
  was_home: boolean;
  round: number;                  // gameweek id
  kickoff_time: string;
  minutes: number;
  starts: number;
  goals_scored: number;
  assists: number;
  clean_sheets: number;
  goals_conceded: number;
  own_goals: number;
  penalties_saved: number;
  penalties_missed: number;
  yellow_cards: number;
  red_cards: number;
  saves: number;
  bonus: number;
  bps: number;
  total_points: number;
  expected_goals: string;
  expected_assists: string;
  expected_goal_involvements: string;
  expected_goals_conceded: string;
}
export interface FplElementSummary {
  fixtures: unknown[];
  history: FplElementHistoryRow[];
  history_past?: unknown[];
}

export interface FplClassicLeague {
  league: { id: number; name: string };
  standings: {
    results: Array<{
      rank: number;
      last_rank: number | null;
      entry: number;
      entry_name: string;
      player_name: string;
      total: number;
      event_total: number;
    }>;
  };
}
