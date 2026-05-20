#!/usr/bin/env tsx
/**
 * Debug script: run `fetchTranscript` against a single YouTube videoId
 * and print exactly what happened. Use this when the main ingest reports
 * `no_captions` and you want to know which strategy failed and why.
 *
 *   npx tsx scripts/probe-transcript.ts <videoId>
 *
 * Or, to test all unprocessed videos currently in the DB (no DB writes):
 *   npx tsx scripts/probe-transcript.ts --queue
 *
 * Examples:
 *   npx tsx scripts/probe-transcript.ts dQw4w9WgXcQ
 *   npx tsx scripts/probe-transcript.ts --queue
 *
 * What it prints, per video:
 *   - the composite error string (which records what each of the 4
 *     fallback strategies returned)
 *   - the first 5 cues if we got any, so you can spot caption junk
 *
 * Does NOT write anything to the database.
 */
import { sql } from '../src/lib/db/client';
import { fetchTranscript } from '../src/lib/youtube/transcript';

async function probe(videoId: string, title?: string) {
  const label = title ? `${title.slice(0, 60)} (${videoId})` : videoId;
  process.stdout.write(`→ ${label}\n`);
  const r = await fetchTranscript(videoId);
  process.stdout.write(`   status: ${r.status}\n`);
  if (r.error) process.stdout.write(`   reason: ${r.error}\n`);
  if (r.cues.length > 0) {
    process.stdout.write(`   cues:   ${r.cues.length} total — first 5:\n`);
    for (const cue of r.cues.slice(0, 5)) {
      const t = cue.startSec.toFixed(1).padStart(7, ' ');
      process.stdout.write(`     [${t}s] ${cue.text.slice(0, 80)}\n`);
    }
  }
  process.stdout.write('\n');
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write('Usage: tsx scripts/probe-transcript.ts <videoId|--queue>\n');
    process.exit(2);
  }

  if (arg === '--queue') {
    // Probe every video that the main ingest hasn't successfully captioned.
    // Includes 'no_captions', 'error', 'skipped_old_gw' so we can see what
    // a re-run with the current fetcher would do — but writes nothing.
    const rows = await sql<Array<{ video_id: string; title: string; transcript_status: string | null }>>`
      SELECT video_id, title, transcript_status
        FROM youtube_videos
       WHERE transcript_status IS DISTINCT FROM 'ok'
       ORDER BY published_at DESC
       LIMIT 20
    `;
    process.stdout.write(`probing ${rows.length} videos with status != ok\n\n`);
    for (const r of rows) await probe(r.video_id, r.title);
  } else {
    await probe(arg);
  }
  await sql.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
