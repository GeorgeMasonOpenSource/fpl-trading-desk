-- =============================================================================
-- 0011 — Per-position defensive ratings.
--
-- Currently `teams.defensive_solidity` is a single number per team. That
-- collapses real-world dynamics: Leeds might be terrible at defending fast
-- forwards but acceptable at suppressing midfielder long-shots. The single
-- multiplier averages those, undervaluing a forward's expected goals
-- against LEE and overvaluing a midfielder's.
--
-- FPLReview does not separate these. Our structural advantage.
--
-- Computed from player_shot_history: for each (opponent_team, shooter_position),
-- SUM the xG of every shot taken against that team by that position. Divide
-- by matches played against. Compare to league average for that position.
-- Result: a per-team, per-position "defensive_vs_X" multiplier.
-- =============================================================================

CREATE TABLE IF NOT EXISTS team_defence_by_position (
  team_id              INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  attacker_position    TEXT NOT NULL CHECK (attacker_position IN ('GKP','DEF','MID','FWD')),
  -- xG conceded to attackers of this position, summed across the season.
  total_xg_conceded    NUMERIC(8,3) NOT NULL DEFAULT 0,
  shots_conceded       INT NOT NULL DEFAULT 0,
  goals_conceded       INT NOT NULL DEFAULT 0,
  matches              INT NOT NULL DEFAULT 0,
  -- The per-match xG conceded to this position.
  xg_per_match         NUMERIC(6,3) NOT NULL DEFAULT 0,
  -- Multiplier vs league average for this position. > 1.0 = leaky vs this
  -- position; < 1.0 = strong vs this position. Used by the engine as
  -- opponent.defence_vs_FWD instead of the single defensive_solidity.
  multiplier           NUMERIC(5,3) NOT NULL DEFAULT 1.0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, attacker_position)
);

CREATE INDEX IF NOT EXISTS tdbp_team_idx ON team_defence_by_position (team_id);

INSERT INTO schema_migrations (version) VALUES ('0011_per_position_defence')
  ON CONFLICT (version) DO NOTHING;
