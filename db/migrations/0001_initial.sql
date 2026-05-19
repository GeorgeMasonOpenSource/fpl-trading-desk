-- =============================================================================
-- FPL Trading Desk — initial schema (v1)
-- Deterministic, transparent, reproducible. No ML / no LLM state lives here.
-- All projection inputs and outputs are persisted so every decision can be
-- audited and replayed.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- Raw ingestion: keep every payload we ever fetched. Cheap, audit-friendly,
-- and lets us re-derive normalised tables without re-hitting upstream APIs.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw_fpl_responses (
  id              BIGSERIAL PRIMARY KEY,
  source          TEXT NOT NULL,             -- e.g. 'bootstrap-static', 'event-live', 'manager-picks'
  url             TEXT NOT NULL,
  status_code     INT  NOT NULL,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  gameweek        INT,                       -- optional context
  entity_id       BIGINT,                    -- optional context (manager id, league id, etc.)
  payload         JSONB NOT NULL,
  payload_hash    TEXT NOT NULL,             -- sha256 of payload, lets us dedupe identical fetches
  UNIQUE (source, entity_id, gameweek, payload_hash)
);
CREATE INDEX IF NOT EXISTS raw_fpl_responses_source_time ON raw_fpl_responses (source, fetched_at DESC);

-- -----------------------------------------------------------------------------
-- Core normalised entities
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teams (
  id              INT PRIMARY KEY,                 -- FPL team id
  code            INT NOT NULL,                    -- FPL team code (stable across seasons)
  name            TEXT NOT NULL,
  short_name      TEXT NOT NULL,
  strength        INT  NOT NULL DEFAULT 1000,      -- internal Elo-style rating (1000 = neutral)
  strength_home   INT  NOT NULL DEFAULT 1000,
  strength_away   INT  NOT NULL DEFAULT 1000,
  strength_attack_home INT NOT NULL DEFAULT 1000,
  strength_attack_away INT NOT NULL DEFAULT 1000,
  strength_def_home    INT NOT NULL DEFAULT 1000,
  strength_def_away    INT NOT NULL DEFAULT 1000,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gameweeks (
  id              INT PRIMARY KEY,              -- FPL event id
  name            TEXT NOT NULL,
  deadline_time   TIMESTAMPTZ NOT NULL,
  is_current      BOOLEAN NOT NULL DEFAULT FALSE,
  is_next         BOOLEAN NOT NULL DEFAULT FALSE,
  is_previous     BOOLEAN NOT NULL DEFAULT FALSE,
  finished        BOOLEAN NOT NULL DEFAULT FALSE,
  data_checked    BOOLEAN NOT NULL DEFAULT FALSE,
  average_entry_score INT,
  highest_score   INT,
  chip_plays      JSONB,
  most_captained  INT,
  most_vice_captained INT,
  most_selected   INT,
  most_transferred_in INT,
  top_element     INT,
  top_element_info JSONB
);

CREATE TABLE IF NOT EXISTS players (
  id              INT PRIMARY KEY,              -- FPL element id
  code            INT NOT NULL,                 -- FPL element code
  team_id         INT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  position        TEXT NOT NULL CHECK (position IN ('GKP','DEF','MID','FWD')),
  first_name      TEXT NOT NULL,
  second_name     TEXT NOT NULL,
  web_name        TEXT NOT NULL,
  now_cost        INT  NOT NULL,                -- price in tenths (e.g. 95 = £9.5m)
  status          TEXT NOT NULL DEFAULT 'a',    -- a, d, i, n, s, u (FPL availability flag)
  news            TEXT,
  news_added_at   TIMESTAMPTZ,
  chance_of_playing_next_round INT,
  chance_of_playing_this_round INT,
  selected_by_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  transfers_in_event  BIGINT NOT NULL DEFAULT 0,
  transfers_out_event BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS players_team_idx    ON players (team_id);
CREATE INDEX IF NOT EXISTS players_position_idx ON players (position);

CREATE TABLE IF NOT EXISTS fixtures (
  id              INT PRIMARY KEY,                -- FPL fixture id
  gameweek_id     INT REFERENCES gameweeks(id) ON DELETE SET NULL,
  kickoff_time    TIMESTAMPTZ,
  team_h          INT NOT NULL REFERENCES teams(id),
  team_a          INT NOT NULL REFERENCES teams(id),
  team_h_difficulty INT,
  team_a_difficulty INT,
  team_h_score    INT,
  team_a_score    INT,
  finished        BOOLEAN NOT NULL DEFAULT FALSE,
  started         BOOLEAN NOT NULL DEFAULT FALSE,
  minutes         INT NOT NULL DEFAULT 0,
  stats           JSONB,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fixtures_gw_idx ON fixtures (gameweek_id);
CREATE INDEX IF NOT EXISTS fixtures_team_h_idx ON fixtures (team_h);
CREATE INDEX IF NOT EXISTS fixtures_team_a_idx ON fixtures (team_a);

-- -----------------------------------------------------------------------------
-- Historical signal — what actually happened.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_gameweek_history (
  player_id       INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  gameweek_id     INT NOT NULL REFERENCES gameweeks(id) ON DELETE CASCADE,
  fixture_id      INT REFERENCES fixtures(id),
  opponent_team   INT REFERENCES teams(id),
  was_home        BOOLEAN,
  minutes         INT NOT NULL DEFAULT 0,
  goals_scored    INT NOT NULL DEFAULT 0,
  assists         INT NOT NULL DEFAULT 0,
  clean_sheets    INT NOT NULL DEFAULT 0,
  goals_conceded  INT NOT NULL DEFAULT 0,
  own_goals       INT NOT NULL DEFAULT 0,
  penalties_saved INT NOT NULL DEFAULT 0,
  penalties_missed INT NOT NULL DEFAULT 0,
  yellow_cards    INT NOT NULL DEFAULT 0,
  red_cards       INT NOT NULL DEFAULT 0,
  saves           INT NOT NULL DEFAULT 0,
  bonus           INT NOT NULL DEFAULT 0,
  bps             INT NOT NULL DEFAULT 0,
  expected_goals      NUMERIC(6,3) NOT NULL DEFAULT 0,
  expected_assists    NUMERIC(6,3) NOT NULL DEFAULT 0,
  expected_goal_involvements NUMERIC(6,3) NOT NULL DEFAULT 0,
  expected_goals_conceded    NUMERIC(6,3) NOT NULL DEFAULT 0,
  total_points    INT NOT NULL DEFAULT 0,
  starts          INT NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, gameweek_id, fixture_id)
);
CREATE INDEX IF NOT EXISTS pgh_gw_idx ON player_gameweek_history (gameweek_id);

CREATE TABLE IF NOT EXISTS player_season_history (
  player_id       INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season_name     TEXT NOT NULL,                  -- e.g. '2023/24'
  minutes         INT NOT NULL DEFAULT 0,
  starts          INT NOT NULL DEFAULT 0,
  goals_scored    INT NOT NULL DEFAULT 0,
  assists         INT NOT NULL DEFAULT 0,
  clean_sheets    INT NOT NULL DEFAULT 0,
  expected_goals      NUMERIC(8,3) NOT NULL DEFAULT 0,
  expected_assists    NUMERIC(8,3) NOT NULL DEFAULT 0,
  bonus           INT NOT NULL DEFAULT 0,
  total_points    INT NOT NULL DEFAULT 0,
  yellow_cards    INT NOT NULL DEFAULT 0,
  red_cards       INT NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, season_name)
);

-- -----------------------------------------------------------------------------
-- Player baselines: long-term role-adjusted priors. Recomputed deterministically
-- from season history + current season evidence. Recent goals are NOT chased
-- here — the engine downweights small samples elsewhere.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_baselines (
  player_id           INT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  baseline_minutes_per_app NUMERIC(6,2) NOT NULL DEFAULT 0,
  baseline_start_rate      NUMERIC(5,4) NOT NULL DEFAULT 0,
  baseline_xg_per_90       NUMERIC(6,3) NOT NULL DEFAULT 0,
  baseline_xa_per_90       NUMERIC(6,3) NOT NULL DEFAULT 0,
  baseline_xgi_per_90      NUMERIC(6,3) NOT NULL DEFAULT 0,
  baseline_bonus_per_90    NUMERIC(6,3) NOT NULL DEFAULT 0,
  baseline_cs_share        NUMERIC(5,4) NOT NULL DEFAULT 0,
  baseline_yellow_per_90   NUMERIC(6,3) NOT NULL DEFAULT 0,
  baseline_red_per_90      NUMERIC(6,3) NOT NULL DEFAULT 0,
  baseline_saves_per_90    NUMERIC(6,3) NOT NULL DEFAULT 0,
  baseline_pen_save_per_90 NUMERIC(6,3) NOT NULL DEFAULT 0,
  sample_size_minutes      INT NOT NULL DEFAULT 0,
  reliability_index        NUMERIC(5,4) NOT NULL DEFAULT 0,   -- 0..1 historical availability + rotation resistance
  computed_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Team strength (deterministic, refreshed from recent results + xG)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS team_strengths (
  team_id         INT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  attack_rating   NUMERIC(6,3) NOT NULL DEFAULT 1.0,   -- goals/match vs league avg, multiplicative
  defence_rating  NUMERIC(6,3) NOT NULL DEFAULT 1.0,   -- xGA suppression, multiplicative
  home_advantage  NUMERIC(6,3) NOT NULL DEFAULT 0.15,  -- additive log-shift
  pace            NUMERIC(6,3) NOT NULL DEFAULT 1.0,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Lineup, benches, substitutions (current season evidence for the role matrix)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS team_lineups (
  fixture_id      INT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  team_id         INT NOT NULL REFERENCES teams(id),
  player_id       INT NOT NULL REFERENCES players(id),
  is_start        BOOLEAN NOT NULL,
  position        TEXT,            -- 'LW','RW','ST','CM','LB','GK', etc.
  formation       TEXT,            -- e.g. '4-2-3-1'
  source          TEXT NOT NULL DEFAULT 'fpl',
  PRIMARY KEY (fixture_id, player_id)
);
CREATE INDEX IF NOT EXISTS team_lineups_team_idx ON team_lineups (team_id);

CREATE TABLE IF NOT EXISTS team_benches (
  fixture_id      INT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  team_id         INT NOT NULL REFERENCES teams(id),
  player_id       INT NOT NULL REFERENCES players(id),
  came_on         BOOLEAN NOT NULL DEFAULT FALSE,
  minutes_played  INT NOT NULL DEFAULT 0,
  PRIMARY KEY (fixture_id, player_id)
);

CREATE TABLE IF NOT EXISTS substitutions (
  fixture_id      INT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  team_id         INT NOT NULL REFERENCES teams(id),
  player_off      INT REFERENCES players(id),
  player_on       INT REFERENCES players(id),
  minute          INT NOT NULL,
  reason          TEXT,             -- 'tactical','injury','rotation','time-wasting',...
  PRIMARY KEY (fixture_id, minute, player_on, player_off)
);

-- -----------------------------------------------------------------------------
-- Manager (user) state
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manager_teams (
  manager_id      BIGINT PRIMARY KEY,
  name            TEXT,
  player_first_name TEXT,
  player_last_name  TEXT,
  favourite_team  INT REFERENCES teams(id),
  total_points    INT NOT NULL DEFAULT 0,
  overall_rank    BIGINT,
  bank            INT NOT NULL DEFAULT 0,            -- £m * 10
  team_value      INT NOT NULL DEFAULT 1000,
  free_transfers  INT NOT NULL DEFAULT 1,
  last_deadline_total_transfers INT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS manager_picks (
  manager_id      BIGINT NOT NULL REFERENCES manager_teams(manager_id) ON DELETE CASCADE,
  gameweek_id     INT NOT NULL REFERENCES gameweeks(id),
  player_id       INT NOT NULL REFERENCES players(id),
  position        INT NOT NULL,                 -- 1..15 in FPL slot order
  is_captain      BOOLEAN NOT NULL DEFAULT FALSE,
  is_vice         BOOLEAN NOT NULL DEFAULT FALSE,
  multiplier      INT NOT NULL DEFAULT 1,       -- 0 bench, 1 playing, 2 captain, 3 triple captain
  purchase_price  INT,
  selling_price   INT,
  PRIMARY KEY (manager_id, gameweek_id, position)
);

CREATE TABLE IF NOT EXISTS manager_transfers (
  manager_id      BIGINT NOT NULL REFERENCES manager_teams(manager_id) ON DELETE CASCADE,
  gameweek_id     INT NOT NULL REFERENCES gameweeks(id),
  player_in       INT NOT NULL REFERENCES players(id),
  player_out      INT NOT NULL REFERENCES players(id),
  cost_in         INT NOT NULL,
  cost_out        INT NOT NULL,
  transferred_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (manager_id, gameweek_id, player_in, player_out)
);

-- -----------------------------------------------------------------------------
-- Classic mini league
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS classic_league_standings (
  league_id       BIGINT NOT NULL,
  gameweek_id     INT NOT NULL,
  rank            INT NOT NULL,
  last_rank       INT,
  entry           BIGINT NOT NULL,                -- manager id
  entry_name      TEXT,
  player_name     TEXT,
  total           INT NOT NULL,
  event_total     INT NOT NULL,
  snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, gameweek_id, entry, snapshot_at)
);
CREATE INDEX IF NOT EXISTS cls_league_idx ON classic_league_standings (league_id, gameweek_id);

-- -----------------------------------------------------------------------------
-- Role matrix — current season evidence, expiring, never hard-coded
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_role_matrix (
  player_id           INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  role                TEXT NOT NULL,             -- 'ST','LW','RW','AM','LM','RM','CM','DM','CB','LB','RB','LWB','RWB','GK'
  role_type           TEXT NOT NULL CHECK (role_type IN ('primary','secondary','emergency')),
  suitability         NUMERIC(5,4) NOT NULL DEFAULT 0, -- 0..1
  confidence          NUMERIC(5,4) NOT NULL DEFAULT 0, -- 0..1
  evidence_level      TEXT NOT NULL DEFAULT 'low',     -- low|medium|high
  source              TEXT NOT NULL DEFAULT 'derived', -- derived|manual_override|news
  last_verified_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ,                     -- once past, decay kicks in
  PRIMARY KEY (player_id, role, role_type)
);

CREATE TABLE IF NOT EXISTS player_role_observations (
  id              BIGSERIAL PRIMARY KEY,
  player_id       INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  fixture_id      INT REFERENCES fixtures(id),
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  role            TEXT NOT NULL,
  minutes         INT NOT NULL DEFAULT 0,
  formation       TEXT,
  weight          NUMERIC(5,4) NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS pro_player_idx ON player_role_observations (player_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS team_depth_chart_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  team_id         INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  chart           JSONB NOT NULL,            -- { position: [{player_id, depth, confidence}] }
  confidence      NUMERIC(5,4) NOT NULL DEFAULT 0.5
);

CREATE TABLE IF NOT EXISTS lineup_observations (
  id              BIGSERIAL PRIMARY KEY,
  fixture_id      INT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  team_id         INT NOT NULL REFERENCES teams(id),
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  starters        INT[] NOT NULL,
  bench           INT[] NOT NULL,
  formation       TEXT
);

CREATE TABLE IF NOT EXISTS formation_observations (
  id              BIGSERIAL PRIMARY KEY,
  team_id         INT NOT NULL REFERENCES teams(id),
  fixture_id      INT NOT NULL REFERENCES fixtures(id),
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  formation       TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'fpl'
);

CREATE TABLE IF NOT EXISTS role_confidence_history (
  id              BIGSERIAL PRIMARY KEY,
  player_id       INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  confidence      NUMERIC(5,4) NOT NULL,
  reason          TEXT,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS manual_role_overrides (
  id              BIGSERIAL PRIMARY KEY,
  player_id       INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  role_type       TEXT NOT NULL CHECK (role_type IN ('primary','secondary','emergency','exclude')),
  reason          TEXT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Fixture congestion + European fixtures
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS european_fixtures (
  id              BIGSERIAL PRIMARY KEY,
  team_id         INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  competition     TEXT NOT NULL CHECK (competition IN ('UCL','UEL','UECL','FA','EFL','OTHER')),
  kickoff_time    TIMESTAMPTZ NOT NULL,
  opponent        TEXT NOT NULL,
  is_home         BOOLEAN NOT NULL DEFAULT FALSE,
  importance      NUMERIC(4,2) NOT NULL DEFAULT 1.0, -- 0..2
  source          TEXT NOT NULL DEFAULT 'manual',
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eu_fixtures_team_time_idx ON european_fixtures (team_id, kickoff_time);

CREATE TABLE IF NOT EXISTS fixture_congestion (
  team_id         INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  fixture_id      INT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  days_rest_before INT,
  days_rest_after  INT,
  travel_burden    NUMERIC(5,2) NOT NULL DEFAULT 0,
  competition_importance NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  rotation_pressure  NUMERIC(5,3) NOT NULL DEFAULT 0,   -- 0..1
  fatigue_pressure   NUMERIC(5,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, fixture_id)
);

-- -----------------------------------------------------------------------------
-- Injuries
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS injury_status_history (
  id              BIGSERIAL PRIMARY KEY,
  player_id       INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  status          TEXT NOT NULL,                  -- a, d, i, n, s, u
  chance_of_playing_next INT,
  news            TEXT,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Minutes engine output (per player, per upcoming fixture)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS minutes_projections (
  player_id              INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  fixture_id             INT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  start_prob             NUMERIC(5,4) NOT NULL DEFAULT 0,
  sixty_plus_prob        NUMERIC(5,4) NOT NULL DEFAULT 0,
  ninety_prob            NUMERIC(5,4) NOT NULL DEFAULT 0,
  sub_prob               NUMERIC(5,4) NOT NULL DEFAULT 0,
  bench_unused_prob      NUMERIC(5,4) NOT NULL DEFAULT 0,
  injury_absence_prob    NUMERIC(5,4) NOT NULL DEFAULT 0,
  expected_minutes       NUMERIC(6,2) NOT NULL DEFAULT 0,
  early_sub_risk         NUMERIC(5,4) NOT NULL DEFAULT 0,
  rotation_risk          NUMERIC(5,4) NOT NULL DEFAULT 0,
  rotation_resistance    NUMERIC(5,4) NOT NULL DEFAULT 0,
  minutes_confidence     NUMERIC(5,4) NOT NULL DEFAULT 0,
  reliability_index      NUMERIC(5,4) NOT NULL DEFAULT 0,
  reasons                JSONB,
  computed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, fixture_id)
);

CREATE TABLE IF NOT EXISTS rotation_risk_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  player_id       INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  gameweek_id     INT NOT NULL REFERENCES gameweeks(id),
  rotation_risk   NUMERIC(5,4) NOT NULL,
  reason          TEXT,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Projection engine output (per player, per upcoming fixture)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projections (
  player_id           INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  fixture_id          INT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  gameweek_id         INT NOT NULL REFERENCES gameweeks(id),
  xpts_total          NUMERIC(6,3) NOT NULL DEFAULT 0,
  xpts_appearance     NUMERIC(6,3) NOT NULL DEFAULT 0,
  xpts_goals          NUMERIC(6,3) NOT NULL DEFAULT 0,
  xpts_assists        NUMERIC(6,3) NOT NULL DEFAULT 0,
  xpts_clean_sheet    NUMERIC(6,3) NOT NULL DEFAULT 0,
  xpts_bonus          NUMERIC(6,3) NOT NULL DEFAULT 0,
  xpts_saves          NUMERIC(6,3) NOT NULL DEFAULT 0,
  xpts_pen_save       NUMERIC(6,3) NOT NULL DEFAULT 0,
  xpts_cards          NUMERIC(6,3) NOT NULL DEFAULT 0,
  xpts_concede        NUMERIC(6,3) NOT NULL DEFAULT 0,
  xpts_owngoal        NUMERIC(6,3) NOT NULL DEFAULT 0,
  floor               NUMERIC(6,3) NOT NULL DEFAULT 0,
  ceiling             NUMERIC(6,3) NOT NULL DEFAULT 0,
  risk_score          NUMERIC(5,4) NOT NULL DEFAULT 0,   -- 0..1
  confidence_score    NUMERIC(5,4) NOT NULL DEFAULT 0,   -- 0..1
  reasons             JSONB,
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, fixture_id)
);
CREATE INDEX IF NOT EXISTS projections_gw_idx ON projections (gameweek_id);

-- Append-only snapshots for auditability / backtesting
CREATE TABLE IF NOT EXISTS projection_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  taken_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  gameweek_id     INT NOT NULL REFERENCES gameweeks(id),
  player_id       INT NOT NULL REFERENCES players(id),
  fixture_id      INT NOT NULL REFERENCES fixtures(id),
  payload         JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS proj_snap_gw_idx ON projection_snapshots (gameweek_id, taken_at DESC);

-- -----------------------------------------------------------------------------
-- Decision simulations (cached so we don't re-optimise on every page load)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transfer_simulations (
  id              BIGSERIAL PRIMARY KEY,
  manager_id      BIGINT NOT NULL,
  gameweek_id     INT NOT NULL,
  horizon         INT NOT NULL,                   -- 1, 3, 6, 8
  scenario        TEXT NOT NULL,                  -- 'do_nothing','roll','ft1','ft2','hit_-4','hit_-8','wildcard'
  squad_before    JSONB NOT NULL,
  moves           JSONB NOT NULL,
  squad_after     JSONB NOT NULL,
  ev_gain         NUMERIC(6,3) NOT NULL,
  risk            NUMERIC(5,4) NOT NULL,
  confidence      NUMERIC(5,4) NOT NULL,
  opportunity_cost NUMERIC(6,3) NOT NULL DEFAULT 0,
  flexibility_score NUMERIC(5,4) NOT NULL DEFAULT 0,
  reasons         JSONB,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tsim_manager_idx ON transfer_simulations (manager_id, gameweek_id);

CREATE TABLE IF NOT EXISTS captaincy_simulations (
  id              BIGSERIAL PRIMARY KEY,
  manager_id      BIGINT,
  gameweek_id     INT NOT NULL,
  player_id       INT NOT NULL REFERENCES players(id),
  projection      NUMERIC(6,3) NOT NULL,
  ceiling         NUMERIC(6,3) NOT NULL,
  floor           NUMERIC(6,3) NOT NULL,
  start_prob      NUMERIC(5,4) NOT NULL,
  effective_ownership NUMERIC(6,3) NOT NULL DEFAULT 0,
  ml_impact       NUMERIC(6,3) NOT NULL DEFAULT 0,    -- mini-league impact
  triple_cap_score NUMERIC(6,3) NOT NULL DEFAULT 0,
  reasons         JSONB,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS csim_gw_idx ON captaincy_simulations (gameweek_id);

CREATE TABLE IF NOT EXISTS chip_simulations (
  id              BIGSERIAL PRIMARY KEY,
  manager_id      BIGINT NOT NULL,
  gameweek_id     INT NOT NULL,
  chip            TEXT NOT NULL CHECK (chip IN ('WC','FH','BB','TC')),
  ev              NUMERIC(6,3) NOT NULL,
  risk            NUMERIC(5,4) NOT NULL,
  confidence      NUMERIC(5,4) NOT NULL,
  opportunity_cost NUMERIC(6,3) NOT NULL DEFAULT 0,
  best_week_projected INT,
  payload         JSONB,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mini_league_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  league_id       BIGINT NOT NULL,
  manager_id      BIGINT NOT NULL,
  gameweek_id     INT NOT NULL,
  payload         JSONB NOT NULL,    -- live table, captains, eo, threats, swings, autosubs, bonus
  taken_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mls_lookup_idx ON mini_league_snapshots (league_id, manager_id, gameweek_id, taken_at DESC);

-- -----------------------------------------------------------------------------
-- Recommendation log — every action surfaced to the user, with what we knew at the time
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recommendation_history (
  id              BIGSERIAL PRIMARY KEY,
  manager_id      BIGINT NOT NULL,
  gameweek_id     INT NOT NULL,
  kind            TEXT NOT NULL,                  -- 'transfer','captain','chip','roll','no_op'
  payload         JSONB NOT NULL,
  ev              NUMERIC(6,3) NOT NULL DEFAULT 0,
  risk            NUMERIC(5,4) NOT NULL DEFAULT 0,
  confidence      NUMERIC(5,4) NOT NULL DEFAULT 0,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rec_manager_gw_idx ON recommendation_history (manager_id, gameweek_id);

-- -----------------------------------------------------------------------------
-- Backtesting
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backtest_runs (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  spec            JSONB NOT NULL,                 -- which rules / windows / cohorts
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  summary         JSONB
);

CREATE TABLE IF NOT EXISTS backtest_results (
  id              BIGSERIAL PRIMARY KEY,
  run_id          BIGINT NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  metric          TEXT NOT NULL,
  scope           TEXT NOT NULL,                  -- 'global','position','team','cohort'
  scope_value     TEXT,
  value           NUMERIC(10,5) NOT NULL,
  detail          JSONB
);
CREATE INDEX IF NOT EXISTS br_run_metric_idx ON backtest_results (run_id, metric);

-- -----------------------------------------------------------------------------
-- Manual overrides: structured facts only (no opinion-based recommendations)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manual_overrides (
  id              BIGSERIAL PRIMARY KEY,
  scope           TEXT NOT NULL,        -- 'player','team','fixture'
  scope_id        INT NOT NULL,
  kind            TEXT NOT NULL,        -- 'role','availability','minutes_cap','rotation','penalty_taker','set_piece','team_objective', etc.
  value           JSONB NOT NULL,
  reason          TEXT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mo_scope_idx ON manual_overrides (scope, scope_id, kind);

-- -----------------------------------------------------------------------------
-- Schema bookkeeping
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version         TEXT PRIMARY KEY,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations (version) VALUES ('0001_initial')
  ON CONFLICT (version) DO NOTHING;
