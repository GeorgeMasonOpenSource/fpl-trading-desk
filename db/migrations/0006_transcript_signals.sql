-- =============================================================================
-- 0006 — YouTube creator-signal ingestion.
--
-- DETERMINISM CONTRACT (important):
--   - The projection engine NEVER reads from these tables directly.
--   - The user reviews each signal and clicks Accept → that creates a
--     manual_override row, which the engine does read.
--   - Raw quotes + timestamps are kept verbatim for human audit / verification.
--   - This is treated as factual research notes from public press-conference-
--     equivalent commentary, not as model input.
-- =============================================================================

CREATE TABLE IF NOT EXISTS youtube_videos (
  video_id              TEXT PRIMARY KEY,
  channel_id            TEXT NOT NULL,
  channel_name          TEXT NOT NULL,
  title                 TEXT NOT NULL,
  published_at          TIMESTAMPTZ NOT NULL,
  url                   TEXT NOT NULL,
  transcript_fetched_at TIMESTAMPTZ,
  transcript_status     TEXT,                              -- 'ok' | 'no_captions' | 'error'
  transcript_error      TEXT
);

CREATE INDEX IF NOT EXISTS yt_videos_channel_idx ON youtube_videos (channel_id, published_at DESC);

CREATE TABLE IF NOT EXISTS transcript_signals (
  id            BIGSERIAL PRIMARY KEY,
  video_id      TEXT NOT NULL REFERENCES youtube_videos(video_id) ON DELETE CASCADE,
  player_id     INT  NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  -- Factual claims:
  --   start | bench | injury | penalty | setpiece
  -- Editorial claims:
  --   recommend | watching | buying | selling
  signal_kind   TEXT NOT NULL CHECK (signal_kind IN (
    'start','bench','injury','penalty','setpiece',
    'recommend','watching','buying','selling'
  )),
  -- 0..1 — derived from pattern strength (exact-name match = high,
  -- nickname/aliased match = medium, ambiguous = low).
  confidence    NUMERIC(4,3) NOT NULL DEFAULT 0.5,
  raw_quote     TEXT NOT NULL,                              -- verbatim context for human verification
  timestamp_sec INT  NOT NULL,                              -- seconds into the video where the quote starts
  -- User action: NULL = pending review, otherwise 'accepted' / 'dismissed'.
  user_action          TEXT,
  accepted_override_id INT,                                 -- FK to manual_overrides.id once accepted
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at   TIMESTAMPTZ,
  UNIQUE (video_id, player_id, signal_kind, timestamp_sec)
);

CREATE INDEX IF NOT EXISTS signals_player_idx  ON transcript_signals (player_id);
CREATE INDEX IF NOT EXISTS signals_pending_idx ON transcript_signals (created_at DESC) WHERE user_action IS NULL;
CREATE INDEX IF NOT EXISTS signals_kind_idx    ON transcript_signals (signal_kind);

INSERT INTO schema_migrations (version) VALUES ('0006_transcript_signals')
  ON CONFLICT (version) DO NOTHING;
