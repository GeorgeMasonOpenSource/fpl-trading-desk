import { sql } from '@/lib/db/client';

/**
 * Creator Lineups — assemble each creator's predicted XI, captain, bench,
 * transfers in/out from the signals they verbalised in their most recent
 * planning-GW video.
 *
 * Mapping from signal kind → lineup slot:
 *
 *   start   inside any section            → STARTING XI
 *   bench   inside any section            → BENCH
 *   recommend or buying  inside `captains` section
 *                                         → CAPTAIN PICK
 *   buying  inside `transfers_in`         → TRANSFER IN
 *   selling inside `transfers_out`        → TRANSFER OUT
 *
 * One row per (creator, player, slot). A player can appear in multiple
 * slots if the creator said both ("I'm starting Saka and captaining him").
 *
 * SOURCE OF TRUTH: the most recent video per channel published in the
 * last 7 days. Older videos are excluded so a creator who switched plans
 * mid-week doesn't appear with a stale lineup.
 */

export type LineupSlot =
  | 'starting_xi'
  | 'bench'
  | 'captain'
  | 'transfer_in'
  | 'transfer_out';

export interface LineupPlayer {
  playerId: number;
  webName: string;
  position: 'GKP' | 'DEF' | 'MID' | 'FWD';
  teamShort: string;
  rawQuote: string;
  videoUrl: string;
  timestampSec: number;
  signalKind: string;
}

export interface CreatorLineup {
  channelId: string;
  channelName: string;
  videoId: string;
  videoTitle: string;
  videoUrl: string;
  publishedAt: string;
  startingXi:   LineupPlayer[];
  bench:        LineupPlayer[];
  captain:      LineupPlayer | null;
  transfersIn:  LineupPlayer[];
  transfersOut: LineupPlayer[];
}

interface SignalJoinRow {
  channel_id: string;
  channel_name: string;
  video_id: string;
  video_title: string;
  video_url: string;
  published_at: string;
  player_id: number;
  web_name: string;
  position: 'GKP' | 'DEF' | 'MID' | 'FWD';
  team_short: string;
  signal_kind: string;
  video_section: string | null;
  raw_quote: string;
  timestamp_sec: number;
  confidence: number;
}

export async function getCreatorLineups(): Promise<CreatorLineup[]> {
  // Take the MOST RECENT video per channel in the last 7 days first. If
  // nothing matches (slow week, or you're checking the dashboard right
  // after seeding), fall back to the most recent ok-transcript video per
  // channel of any age — better to show stale info than empty.
  let rows = await fetchSignalRows({ withinDays: 7 });
  if (rows.length === 0) {
    rows = await fetchSignalRows({ withinDays: null });
  }

  // Per-video captain scoring. We score every (video, player) pair by how
  // strongly the surrounding text suggests they're the captain. The highest-
  // scoring player per video becomes that creator's captain pick. This
  // beats the old "first recommend in the captains section wins" rule,
  // which got confused when the creator discussed several options before
  // committing.
  //
  // Scoring rules (additive, max ~10):
  //   +6  raw_quote contains "captaining <name>" or "captain <name>" near mention
  //   +5  raw_quote contains "armband" near mention
  //   +5  raw_quote contains "<name>'s my captain" / "<name> is my captain"
  //   +3  signal is in the captains section AND kind is recommend / buying
  //   +1  per additional signal for that player in the video
  //
  // The closeness check uses a tight 30-char window around the player's
  // verbatim mention so a captain marker about a different player doesn't
  // count.
  const CAPTAIN_RE = /\b(captain(?:ing)?|armband|skipper)\b/i;
  const captainScores = new Map<string, Map<number, number>>(); // videoId → playerId → score

  // Group rows into per-creator lineups.
  const byChannel = new Map<string, CreatorLineup>();
  for (const r of rows) {
    if (!byChannel.has(r.channel_id)) {
      byChannel.set(r.channel_id, {
        channelId: r.channel_id,
        channelName: r.channel_name,
        videoId: r.video_id,
        videoTitle: r.video_title,
        videoUrl: r.video_url,
        publishedAt: r.published_at,
        startingXi: [], bench: [], captain: null,
        transfersIn: [], transfersOut: []
      });
    }
    const lineup = byChannel.get(r.channel_id)!;
    const player: LineupPlayer = {
      playerId: r.player_id,
      webName: r.web_name,
      position: r.position,
      teamShort: r.team_short,
      rawQuote: r.raw_quote,
      videoUrl: `${r.video_url}&t=${r.timestamp_sec}s`,
      timestampSec: r.timestamp_sec,
      signalKind: r.signal_kind
    };

    // Bucket into slots. A player can land in multiple slots — for
    // example a captain pick is also a starting XI pick. We dedupe at
    // the slot level (no duplicates within a slot) but allow the same
    // player to span slots.
    switch (r.signal_kind) {
      case 'start':
        addUnique(lineup.startingXi, player);
        break;
      case 'bench':
        addUnique(lineup.bench, player);
        break;
      case 'recommend':
      case 'buying':
        // Score this player as a captain candidate; the actual captain
        // assignment happens AFTER the loop so we can compare scores.
        if (r.video_section === 'transfers_in' || r.signal_kind === 'buying') {
          addUnique(lineup.transfersIn, player);
        }
        break;
      case 'selling':
        addUnique(lineup.transfersOut, player);
        break;
      // Editorial-only kinds (watching) are intentionally dropped — they
      // aren't part of a concrete lineup.
    }

    // Score this signal toward "is this player the captain?". Score even
    // signals that aren't recommends — a "start" signal with "captaining"
    // in the quote is the strongest possible signal.
    if (!captainScores.has(r.video_id)) captainScores.set(r.video_id, new Map());
    const playerScores = captainScores.get(r.video_id)!;
    let score = playerScores.get(r.player_id) ?? 0;
    if (r.video_section === 'captains' && (r.signal_kind === 'recommend' || r.signal_kind === 'buying')) {
      score += 3;
    }
    if (CAPTAIN_RE.test(r.raw_quote)) {
      // Tight check: the captain word must be near the player name. Most
      // ASR transcripts put the player name within ~30 chars of the
      // captaincy marker.
      const lower = r.raw_quote.toLowerCase();
      const nameIdx = lower.indexOf(r.web_name.toLowerCase());
      const capMatch = CAPTAIN_RE.exec(lower);
      if (nameIdx >= 0 && capMatch && Math.abs(nameIdx - capMatch.index) <= 40) {
        const phrase = capMatch[1]?.toLowerCase() ?? '';
        score += phrase === 'armband' || phrase === 'captaining' || phrase === 'skipper' ? 6 : 4;
      }
    }
    score += 1; // baseline +1 per signal so most-mentioned wins ties
    playerScores.set(r.player_id, score);
  }

  // Resolve the captain for each creator from the per-video scores.
  for (const lineup of byChannel.values()) {
    const scores = captainScores.get(lineup.videoId);
    if (!scores || scores.size === 0) continue;
    let bestPlayerId = -1;
    let bestScore = -1;
    for (const [pid, sc] of scores.entries()) {
      if (sc > bestScore) { bestScore = sc; bestPlayerId = pid; }
    }
    // Require a minimum score so we don't promote noisy mentions to
    // "captain" status. A single passing "recommend in captains" + 1
    // mention = 4, which is the floor.
    if (bestScore < 4) continue;
    // Find the original LineupPlayer that matches this id — could be in
    // any of the slots (startingXi, transfersIn) — or we may need to
    // synthesize one from a signal row.
    const all = [
      ...lineup.startingXi, ...lineup.bench,
      ...lineup.transfersIn, ...lineup.transfersOut
    ];
    let captainPlayer = all.find(p => p.playerId === bestPlayerId);
    if (!captainPlayer) {
      // The player only appeared via a captains-section recommend (we
      // didn't add them to any slot above). Look up the raw row.
      const row = rows.find(r => r.video_id === lineup.videoId && r.player_id === bestPlayerId);
      if (!row) continue;
      captainPlayer = {
        playerId: row.player_id,
        webName: row.web_name,
        position: row.position,
        teamShort: row.team_short,
        rawQuote: row.raw_quote,
        videoUrl: `${row.video_url}&t=${row.timestamp_sec}s`,
        timestampSec: row.timestamp_sec,
        signalKind: row.signal_kind
      };
    }
    lineup.captain = captainPlayer;
    addUnique(lineup.startingXi, captainPlayer);   // captain implies starter
  }

  // Sort starting XI / bench by position so the eye moves GKP → DEF → MID
  // → FWD as a real lineup would render.
  const posOrder: Record<string, number> = { GKP: 0, DEF: 1, MID: 2, FWD: 3 };
  for (const l of byChannel.values()) {
    l.startingXi.sort((a, b) =>
      (posOrder[a.position] ?? 4) - (posOrder[b.position] ?? 4) ||
      a.webName.localeCompare(b.webName)
    );
    l.bench.sort((a, b) =>
      (posOrder[a.position] ?? 4) - (posOrder[b.position] ?? 4) ||
      a.webName.localeCompare(b.webName)
    );
  }
  // Order creators by publish recency — most recent first.
  return Array.from(byChannel.values()).sort((a, b) =>
    b.publishedAt.localeCompare(a.publishedAt)
  );
}

function addUnique(list: LineupPlayer[], p: LineupPlayer) {
  if (list.some(x => x.playerId === p.playerId)) return;
  list.push(p);
}

/**
 * Pull the latest video-per-channel signal join. Splitting the SQL out
 * means we can re-run it with `withinDays = null` as a fallback when the
 * 7-day window has nothing — better to show stale lineups than an empty
 * page after a quiet creator week.
 */
async function fetchSignalRows(opts: { withinDays: number | null }): Promise<SignalJoinRow[]> {
  if (opts.withinDays != null) {
    return await sql<SignalJoinRow[]>`
      WITH latest_per_channel AS (
        SELECT video_id, channel_id, channel_name, title, url, published_at,
               ROW_NUMBER() OVER (
                 PARTITION BY channel_id ORDER BY published_at DESC
               ) AS rn
          FROM youtube_videos
         WHERE published_at > now() - (${opts.withinDays}::int * INTERVAL '1 day')
           AND transcript_status = 'ok'
      )
      SELECT lpc.channel_id, lpc.channel_name,
             lpc.video_id, lpc.title AS video_title,
             lpc.url AS video_url,
             to_char(lpc.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS published_at,
             s.player_id, p.web_name, p.position,
             t.short_name AS team_short,
             s.signal_kind, s.video_section,
             s.raw_quote, s.timestamp_sec, s.confidence
        FROM latest_per_channel lpc
        JOIN transcript_signals s ON s.video_id = lpc.video_id
        JOIN players p ON p.id = s.player_id
        JOIN teams   t ON t.id = p.team_id
       WHERE lpc.rn = 1
       ORDER BY lpc.channel_name, s.confidence DESC
    `;
  }
  // No date filter — always show the most recent video per channel.
  return await sql<SignalJoinRow[]>`
    WITH latest_per_channel AS (
      SELECT video_id, channel_id, channel_name, title, url, published_at,
             ROW_NUMBER() OVER (
               PARTITION BY channel_id ORDER BY published_at DESC
             ) AS rn
        FROM youtube_videos
       WHERE transcript_status = 'ok'
    )
    SELECT lpc.channel_id, lpc.channel_name,
           lpc.video_id, lpc.title AS video_title,
           lpc.url AS video_url,
           to_char(lpc.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS published_at,
           s.player_id, p.web_name, p.position,
           t.short_name AS team_short,
           s.signal_kind, s.video_section,
           s.raw_quote, s.timestamp_sec, s.confidence
      FROM latest_per_channel lpc
      JOIN transcript_signals s ON s.video_id = lpc.video_id
      JOIN players p ON p.id = s.player_id
      JOIN teams   t ON t.id = p.team_id
     WHERE lpc.rn = 1
     ORDER BY lpc.channel_name, s.confidence DESC
  `;
}
