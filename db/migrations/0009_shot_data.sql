-- =============================================================================
-- 0009 — Per-shot xG data from Understat.
--
-- The biggest single accuracy gain we can make without licensed Opta data.
-- Replaces our "total season_xg" baseline with situation-separated xG:
--
--   open_play_xg  — true underlying threat from open play
--   set_piece_xg  — from corners / indirect free kicks (lower priority)
--   penalty_xg    — from penalty kicks (separate, since the model already
--                   adds expected pens via the engine's pen-share term)
--   direct_fk_xg  — direct free kicks scored
--
-- Without this, our model can't tell the difference between:
--   - a forward who takes 5 high-quality open-play shots a game
--   - a forward whose entire xG comes from being on penalties
--
-- The downstream engine reads these per-situation columns instead of the
-- single season_xg total, which removes the heuristic "subtract 5 pens × 0.78"
-- guess and replaces it with the actual count.
-- =============================================================================

-- Per-shot facts. One row per shot the player took this season.
CREATE TABLE IF NOT EXISTS player_shot_history (
  id              BIGSERIAL PRIMARY KEY,
  understat_id    TEXT NOT NULL,                       -- Understat's shot ID
  player_id       INT  NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  -- Match metadata (we don't link to fixtures.id because Understat IDs
  -- don't match FPL fixture IDs; track date + teams instead).
  match_date      DATE NOT NULL,
  team_id         INT  REFERENCES teams(id),
  opponent_team_id INT REFERENCES teams(id),
  is_home         BOOLEAN NOT NULL,
  minute          INT  NOT NULL,
  -- Shot quality
  xg              NUMERIC(7,5) NOT NULL,
  -- Situation: OpenPlay | SetPiece | FromCorner | Penalty | DirectFreekick
  situation       TEXT NOT NULL,
  shot_type       TEXT,                                 -- 'Head' | 'LeftFoot' | 'RightFoot' | 'OtherBodyPart'
  result          TEXT NOT NULL,                        -- 'Goal' | 'SavedShot' | 'MissedShots' | 'BlockedShot' | 'ShotOnPost' | 'OwnGoal'
  -- Position (Understat's xy 0..1, where x=0 is own goal). Useful for
  -- a future shot-location-quality model.
  x_loc           NUMERIC(5,4),
  y_loc           NUMERIC(5,4),
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (understat_id)
);
CREATE INDEX IF NOT EXISTS psh_player_idx ON player_shot_history (player_id, match_date DESC);
CREATE INDEX IF NOT EXISTS psh_situation_idx ON player_shot_history (player_id, situation);

-- Per-player per-situation aggregates. Recomputed by the ingest after
-- each match-batch insert. This is what the engine reads, not the raw
-- shots table — avoids a heavy GROUP BY at projection time.
CREATE TABLE IF NOT EXISTS player_shot_aggregates (
  player_id         INT  PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  -- Counts
  shots_open_play   INT  NOT NULL DEFAULT 0,
  shots_set_piece   INT  NOT NULL DEFAULT 0,
  shots_penalty     INT  NOT NULL DEFAULT 0,
  shots_direct_fk   INT  NOT NULL DEFAULT 0,
  -- Summed xG by situation
  xg_open_play      NUMERIC(8,3) NOT NULL DEFAULT 0,
  xg_set_piece      NUMERIC(8,3) NOT NULL DEFAULT 0,
  xg_penalty        NUMERIC(8,3) NOT NULL DEFAULT 0,
  xg_direct_fk      NUMERIC(8,3) NOT NULL DEFAULT 0,
  -- Outcome counts
  goals_open_play   INT  NOT NULL DEFAULT 0,
  goals_set_piece   INT  NOT NULL DEFAULT 0,
  goals_penalty     INT  NOT NULL DEFAULT 0,
  goals_direct_fk   INT  NOT NULL DEFAULT 0,
  -- Last match included (idempotency anchor for next ingest).
  last_match_date   DATE,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Team-level shots conceded — used to compute opposition-specific shot rates.
CREATE TABLE IF NOT EXISTS team_shot_aggregates (
  team_id           INT  PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  shots_against     INT  NOT NULL DEFAULT 0,
  xg_against        NUMERIC(8,3) NOT NULL DEFAULT 0,
  shots_against_open_play INT NOT NULL DEFAULT 0,
  xg_against_open_play    NUMERIC(8,3) NOT NULL DEFAULT 0,
  matches           INT  NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version) VALUES ('0009_shot_data')
  ON CONFLICT (version) DO NOTHING;
