import { sql } from '@/lib/db/client';
import type { YouTubeVideo } from './fetcher';
import type { ExtractedSignal, NumericClaim, CreatorRankingItem } from './extractor';
import type { TranscriptStatus } from './transcript';

export async function upsertVideo(v: YouTubeVideo) {
  await sql`
    INSERT INTO youtube_videos
      (video_id, channel_id, channel_name, title, published_at, url)
    VALUES
      (${v.videoId}, ${v.channelId}, ${v.channelName}, ${v.title},
       ${v.publishedAt}::timestamptz, ${v.url})
    ON CONFLICT (video_id) DO UPDATE SET
      title = EXCLUDED.title
  `;
}

export async function recordTranscriptStatus(
  videoId: string, status: TranscriptStatus, error?: string
) {
  await sql`
    UPDATE youtube_videos
       SET transcript_fetched_at = now(),
           transcript_status     = ${status},
           transcript_error      = ${error ?? null}
     WHERE video_id = ${videoId}
  `;
}

export async function getUnprocessedVideos(limit = 20): Promise<{
  video_id: string; channel_id: string; channel_name: string;
  title: string; published_at: string;
}[]> {
  return sql<Array<{
    video_id: string; channel_id: string; channel_name: string;
    title: string; published_at: string;
  }>>`
    SELECT video_id, channel_id, channel_name, title, published_at
      FROM youtube_videos
     WHERE transcript_status IS NULL
     ORDER BY published_at DESC
     LIMIT ${limit}
  `;
}

export async function insertSignals(videoId: string, signals: ExtractedSignal[]) {
  if (signals.length === 0) return 0;
  const rows = signals.map(s => ({
    video_id: videoId,
    player_id: s.playerId,
    signal_kind: s.signalKind,
    confidence: s.confidence,
    raw_quote: s.rawQuote,
    timestamp_sec: s.startSec,
    video_section: s.videoSection
  }));
  await sql`
    INSERT INTO transcript_signals ${(sql as any)(rows,
      'video_id', 'player_id', 'signal_kind', 'confidence', 'raw_quote', 'timestamp_sec', 'video_section')}
    ON CONFLICT (video_id, player_id, signal_kind, timestamp_sec) DO NOTHING
  `;
  return rows.length;
}

/**
 * §1b — persist numeric claims attached to player mentions. Skips when the
 * extractor returned nothing so the caller doesn't need to guard. The
 * UNIQUE constraint on (video_id, player_id, metric, timestamp_sec) makes
 * the insert idempotent across re-runs.
 */
export async function insertNumericClaims(videoId: string, claims: NumericClaim[]) {
  if (claims.length === 0) return 0;
  const rows = claims.map(c => ({
    video_id: videoId,
    player_id: c.playerId,
    metric: c.metric,
    metric_value: c.metricValue,
    metric_unit: c.metricUnit,
    raw_quote: c.rawQuote,
    timestamp_sec: c.startSec
  }));
  await sql`
    INSERT INTO transcript_numeric_claims ${(sql as any)(rows,
      'video_id', 'player_id', 'metric', 'metric_value', 'metric_unit', 'raw_quote', 'timestamp_sec')}
    ON CONFLICT (video_id, player_id, metric, timestamp_sec) DO NOTHING
  `;
  return rows.length;
}

/**
 * §1d — persist ordered creator rankings ("my top 3 captains are…"). Caller
 * supplies channel context because rankings are joined to channel for the
 * §2b accuracy leaderboard.
 */
export async function insertCreatorRankings(
  videoId: string,
  channelId: string,
  channelName: string,
  gameweekId: number | null,
  rankings: CreatorRankingItem[]
) {
  if (rankings.length === 0) return 0;
  const rows = rankings.map(r => ({
    video_id: videoId,
    channel_id: channelId,
    channel_name: channelName,
    gameweek_id: gameweekId,
    ranking_kind: r.rankingKind,
    position_rank: r.positionRank,
    player_id: r.playerId,
    raw_quote: r.rawQuote,
    timestamp_sec: r.startSec
  }));
  await sql`
    INSERT INTO creator_rankings ${(sql as any)(rows,
      'video_id', 'channel_id', 'channel_name', 'gameweek_id',
      'ranking_kind', 'position_rank', 'player_id', 'raw_quote', 'timestamp_sec')}
    ON CONFLICT (video_id, ranking_kind, position_rank) DO NOTHING
  `;
  return rows.length;
}
