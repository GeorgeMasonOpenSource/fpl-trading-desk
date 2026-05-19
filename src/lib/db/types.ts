// Shared row-shape types for our normalised tables. We keep them lightweight —
// just the fields the app reads — to avoid coupling every module to a heavy
// generated schema. Pick the field you need, never spread the whole row.

export type Position = 'GKP' | 'DEF' | 'MID' | 'FWD';
export type FplStatus = 'a' | 'd' | 'i' | 'n' | 's' | 'u';

export interface TeamRow {
  id: number;
  code: number;
  name: string;
  short_name: string;
  strength: number;
  strength_home: number;
  strength_away: number;
  strength_attack_home: number;
  strength_attack_away: number;
  strength_def_home: number;
  strength_def_away: number;
}

export interface PlayerRow {
  id: number;
  code: number;
  team_id: number;
  position: Position;
  first_name: string;
  second_name: string;
  web_name: string;
  now_cost: number;
  status: FplStatus;
  news: string | null;
  chance_of_playing_next_round: number | null;
  chance_of_playing_this_round: number | null;
  selected_by_percent: number;
}

export interface GameweekRow {
  id: number;
  name: string;
  deadline_time: string;
  is_current: boolean;
  is_next: boolean;
  is_previous: boolean;
  finished: boolean;
}

export interface FixtureRow {
  id: number;
  gameweek_id: number | null;
  kickoff_time: string | null;
  team_h: number;
  team_a: number;
  team_h_difficulty: number | null;
  team_a_difficulty: number | null;
  finished: boolean;
}

export interface MinutesProjectionRow {
  player_id: number;
  fixture_id: number;
  start_prob: number;
  sixty_plus_prob: number;
  ninety_prob: number;
  sub_prob: number;
  bench_unused_prob: number;
  injury_absence_prob: number;
  expected_minutes: number;
  early_sub_risk: number;
  rotation_risk: number;
  rotation_resistance: number;
  minutes_confidence: number;
  reliability_index: number;
  reasons: ProjectionReason[] | null;
}

export interface ProjectionRow {
  player_id: number;
  fixture_id: number;
  gameweek_id: number;
  xpts_total: number;
  xpts_appearance: number;
  xpts_goals: number;
  xpts_assists: number;
  xpts_clean_sheet: number;
  xpts_bonus: number;
  xpts_saves: number;
  xpts_pen_save: number;
  xpts_cards: number;
  xpts_concede: number;
  xpts_owngoal: number;
  floor: number;
  ceiling: number;
  risk_score: number;
  confidence_score: number;
  reasons: ProjectionReason[] | null;
}

export interface ProjectionReason {
  kind: string;              // e.g. 'fixture_difficulty','rotation_risk','penalty_taker'
  weight: number;            // contribution to total
  detail?: string;           // human readable
}
