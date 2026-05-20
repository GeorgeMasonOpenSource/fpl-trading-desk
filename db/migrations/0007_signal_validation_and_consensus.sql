-- =============================================================================
-- 0007 — Signal validation + creator consensus rollups.
--
-- WHY:
--   - acceptSignal() in app/actions/creator-signals.ts was writing to
--     manual_overrides.source and manual_overrides.notes, which never existed
--     in the schema. The INSERT silently broke at runtime. Adding both columns
--     so the action works, AND so we can record the model's verdict at the
--     time of acceptance (for §2b creator accuracy backtesting).
--
--   - §2a validation badge: each pending signal is stamped with whether the
--     model agrees with the creator's call. We cache the verdict on the
--     signal row so the Creator Board sorts by it without recomputing.
--
--   - §1c consensus rollup: when multiple creators independently flag the
--     same player+kind in the same window, that's a higher-quality signal.
--     A view (refreshed by the query, no MV needed at our row counts) gives
--     us "this pick was endorsed by 3/3 creators in the last 7 days".
-- =============================================================================

-- ---- manual_overrides: align with the code that writes to it -----------------
ALTER TABLE manual_overrides
  ADD COLUMN IF NOT EXISTS source TEXT,                 -- 'youtube:<video_id>', 'manual', etc.
  ADD COLUMN IF NOT EXISTS notes  TEXT;                 -- free-form note (raw_quote on accept)

-- Record what the model thought at the moment the user accepted this signal —
-- 'agrees' | 'neutral' | 'disagrees' | 'no_data'. Lets us backtest creator
-- accuracy without re-deriving the historical projection state.
ALTER TABLE manual_overrides
  ADD COLUMN IF NOT EXISTS model_verdict_at_creation TEXT;

-- ---- transcript_signals: cache the verdict + section context -----------------
-- model_verdict is recomputed when the board page renders, but caching the
-- last-rendered value lets us sort the list "agrees first" without computing
-- inside the SQL ORDER BY.
ALTER TABLE transcript_signals
  ADD COLUMN IF NOT EXISTS model_verdict          TEXT,
  ADD COLUMN IF NOT EXISTS model_verdict_detail   TEXT,
  ADD COLUMN IF NOT EXISTS model_verdict_at       TIMESTAMPTZ,
  -- §1a section-aware extraction: which video section was the signal extracted
  -- from? Lets us weight or invert interpretation downstream.
  ADD COLUMN IF NOT EXISTS video_section          TEXT;   -- 'captains' | 'transfers_in' | 'transfers_out' | 'differentials' | 'avoid' | NULL

CREATE INDEX IF NOT EXISTS signals_verdict_idx
  ON transcript_signals (model_verdict);

-- ---- §1b numerical claims captured from transcripts --------------------------
-- e.g. "Watkins has 0.7 xG per 90 over the last 5", "Bowen 35% of West Ham's
-- chances". Stored alongside the player + verbatim quote so we can validate the
-- creator's number against our own data.
CREATE TABLE IF NOT EXISTS transcript_numeric_claims (
  id            BIGSERIAL PRIMARY KEY,
  video_id      TEXT NOT NULL REFERENCES youtube_videos(video_id) ON DELETE CASCADE,
  player_id     INT  NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  metric        TEXT NOT NULL,                            -- 'xg_per_90', 'goal_involvement_pct', 'returns_in_n', 'minutes', 'shots_in_box', etc.
  metric_value  NUMERIC(10,3) NOT NULL,
  metric_unit   TEXT,                                     -- '%', 'per_90', 'in_5', etc. (free-form)
  raw_quote     TEXT NOT NULL,
  timestamp_sec INT  NOT NULL,
  -- Model's value for the same metric at the time we extracted (computed on
  -- insert by the extractor — null if we don't track that metric ourselves).
  model_value      NUMERIC(10,3),
  agrees_within_pct NUMERIC(5,2),                         -- |claim - model| / model × 100
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (video_id, player_id, metric, timestamp_sec)
);
CREATE INDEX IF NOT EXISTS numeric_claims_player_idx ON transcript_numeric_claims (player_id);
CREATE INDEX IF NOT EXISTS numeric_claims_metric_idx ON transcript_numeric_claims (metric);

-- ---- §1d snapshot verbalised ordered rankings --------------------------------
-- "My top 3 transfers in are 1) Anderson 2) Mbeumo 3) Saka" → 3 rows, ranks 1-3.
-- Foundation for the creator accuracy leaderboard (§2b).
CREATE TABLE IF NOT EXISTS creator_rankings (
  id            BIGSERIAL PRIMARY KEY,
  video_id      TEXT NOT NULL REFERENCES youtube_videos(video_id) ON DELETE CASCADE,
  channel_id    TEXT NOT NULL,
  channel_name  TEXT NOT NULL,
  gameweek_id   INT,                                     -- nullable: not every video targets a specific GW
  ranking_kind  TEXT NOT NULL CHECK (ranking_kind IN (
    'transfers_in','transfers_out','captains','differentials','set_and_forget','avoid'
  )),
  position_rank INT  NOT NULL,                            -- 1, 2, 3, ...
  player_id     INT  NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  raw_quote     TEXT NOT NULL,
  timestamp_sec INT  NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (video_id, ranking_kind, position_rank)
);
CREATE INDEX IF NOT EXISTS creator_rankings_channel_idx
  ON creator_rankings (channel_id, ranking_kind, created_at DESC);
CREATE INDEX IF NOT EXISTS creator_rankings_player_idx
  ON creator_rankings (player_id, ranking_kind);

-- ---- §1c consensus view ------------------------------------------------------
-- Per player, per signal_kind: how many *distinct creators* have flagged this
-- in the last 14 days. We use a plain view (not materialised) because the
-- transcript_signals table is small (thousands of rows per season) and the
-- aggregation is cheap. Refreshing a MV every ingest would add complexity for
-- no measurable win.
CREATE OR REPLACE VIEW creator_consensus AS
SELECT
  s.player_id,
  s.signal_kind,
  COUNT(DISTINCT v.channel_id) AS distinct_creators,
  COUNT(*)                     AS total_mentions,
  MAX(v.published_at)          AS most_recent_at,
  ARRAY_AGG(DISTINCT v.channel_name ORDER BY v.channel_name) AS creator_names
FROM transcript_signals s
JOIN youtube_videos v ON v.video_id = s.video_id
WHERE v.published_at > now() - INTERVAL '14 days'
GROUP BY s.player_id, s.signal_kind;

INSERT INTO schema_migrations (version) VALUES ('0007_signal_validation_and_consensus')
  ON CONFLICT (version) DO NOTHING;
