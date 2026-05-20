#!/usr/bin/env tsx
/**
 * YouTube ingest: pulls latest videos from configured FPL channels,
 * fetches transcripts, extracts deterministic signals, persists them.
 *
 * Run locally (YouTube often rate-limits AWS / Vercel IP ranges):
 *   DATABASE_URL=... DIRECT_DATABASE_URL=... npm run ingest:youtube
 *
 * Idempotent — re-running skips videos with transcript_status set.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from '../src/lib/db/client';
import { fetchChannelVideos } from '../src/lib/youtube/fetcher';
import { fetchTranscript } from '../src/lib/youtube/transcript';
import { extractAll, buildLexicon } from '../src/lib/youtube/extractor';
import { decideGwFilter } from '../src/lib/youtube/gw-filter';
import { isYtDlpAvailable } from '../src/lib/youtube/ytdlp';
import {
  upsertVideo, recordTranscriptStatus, getUnprocessedVideos,
  insertSignals, insertNumericClaims, insertCreatorRankings
} from '../src/lib/youtube/persist';

interface Channel { id: string; name: string; max_age_days?: number; }

async function main() {
  const cfgPath = join(process.cwd(), 'data', 'youtube-channels.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { channels: Channel[] };

  // Probe yt-dlp once up-front so the user gets an early heads-up. Pure-HTTP
  // strategies are very unreliable in 2026 — without yt-dlp this run will
  // almost certainly produce zero signals.
  const ytDlpOk = await isYtDlpAvailable();
  if (ytDlpOk) {
    console.log('→ yt-dlp detected — using it as primary caption fetcher');
  } else {
    console.warn(
      '⚠ yt-dlp NOT detected. Pure-HTTP caption scraping is rate-limited / ' +
      'blocked in 2026. Install with `brew install yt-dlp` (macOS) or ' +
      '`pip install yt-dlp` (Linux/CI) for a working ingest.'
    );
  }

  // 1. Pull latest video metadata via RSS for each channel.
  for (const ch of cfg.channels) {
    try {
      const videos = await fetchChannelVideos(ch.id, ch.name, ch.max_age_days ?? 7);
      console.log(`→ ${ch.name}: ${videos.length} recent videos`);
      for (const v of videos) await upsertVideo(v);
    } catch (err) {
      console.warn(`  ${ch.name}: ${(err as Error).message}`);
    }
  }

  // 2. Load player lexicon once.
  const players = await sql<Array<{
    id: number; web_name: string; first_name: string; second_name: string;
  }>>`SELECT id, web_name, first_name, second_name FROM players WHERE status <> 'u'`;
  const lexicon = buildLexicon(players);
  console.log(`→ lexicon: ${lexicon.length} players`);

  // 3. For each unprocessed video: fetch transcript, extract, persist.
  const queue = await getUnprocessedVideos(20);
  console.log(`→ unprocessed videos: ${queue.length}`);

  // Resolve the current planning gameweek once — every ranking row gets tagged
  // with the GW the video presumably targets so the §2b accuracy backtest has
  // an unambiguous comparison window. We use the next-deadline gameweek; if
  // none (off-season), default to NULL and the backtest skips those rows.
  const gwRow = await sql<Array<{ id: number }>>`
    SELECT id FROM gameweeks
     WHERE deadline_time > now()
     ORDER BY deadline_time ASC
     LIMIT 1
  `;
  const planningGwId: number | null = gwRow[0]?.id ?? null;

  let totalSignals = 0;
  let totalNumeric = 0;
  let totalRankings = 0;
  let skippedOldGw = 0;
  for (const v of queue) {
    try {
      // Skip videos that are clearly about a past gameweek. The decision is
      // purely from the title — we don't have to fetch the transcript to know
      // a "GW37 deadline stream" can't help us plan GW38.
      const gwDecision = decideGwFilter(v.title, planningGwId);
      if (!gwDecision.keep) {
        await recordTranscriptStatus(
          v.video_id,
          'skipped_old_gw',
          `Title targets GW${gwDecision.videoGw}, planning is GW${gwDecision.planningGw}`
        );
        skippedOldGw++;
        console.log(`  ${v.title.slice(0, 60)} — skipped (GW${gwDecision.videoGw} ≠ planning GW${gwDecision.planningGw})`);
        continue;
      }

      const tx = await fetchTranscript(v.video_id);
      if (tx.status !== 'ok') {
        await recordTranscriptStatus(v.video_id, tx.status, tx.error);
        console.log(`  ${v.title.slice(0, 60)} — ${tx.status}${tx.error ? ` (${tx.error})` : ''}`);
        continue;
      }
      const out = extractAll(tx.cues, lexicon);
      const insertedSignals  = await insertSignals(v.video_id, out.signals);
      const insertedNumeric  = await insertNumericClaims(v.video_id, out.numericClaims);
      const insertedRankings = await insertCreatorRankings(
        v.video_id, v.channel_id, v.channel_name, planningGwId, out.rankings
      );
      await recordTranscriptStatus(v.video_id, 'ok');
      totalSignals  += insertedSignals;
      totalNumeric  += insertedNumeric;
      totalRankings += insertedRankings;
      console.log(
        `  ${v.title.slice(0, 60)} — ` +
        `${out.signals.length} signals, ${out.numericClaims.length} num claims, ` +
        `${out.rankings.length} rankings`
      );
    } catch (err) {
      await recordTranscriptStatus(v.video_id, 'error', (err as Error).message);
      console.warn(`  ${v.title.slice(0, 60)} — error: ${(err as Error).message}`);
    }
  }

  console.log(
    `done. ${totalSignals} new signals, ${totalNumeric} numeric claims, ` +
    `${totalRankings} rankings, ${skippedOldGw} videos skipped (old GW).`
  );
  await sql.end();
}

main().catch(err => { console.error(err); process.exit(1); });
