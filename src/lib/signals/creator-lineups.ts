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
  // Take the MOST RECENT video per channel in the last 7 days. The
  // ROW_NUMBER() window ranks by published_at DESC inside each channel,
  // then we keep only rn = 1.
  const rows = await sql<SignalJoinRow[]>`
    WITH latest_per_channel AS (
      SELECT video_id, channel_id, channel_name, title, url, published_at,
             ROW_NUMBER() OVER (
               PARTITION BY channel_id ORDER BY published_at DESC
             ) AS rn
        FROM youtube_videos
       WHERE published_at > now() - INTERVAL '7 days'
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
        if (r.video_section === 'captains' && !lineup.captain) {
          lineup.captain = player;
          addUnique(lineup.startingXi, player); // captain implies starter
        } else if (r.video_section === 'transfers_in' || r.signal_kind === 'buying') {
          addUnique(lineup.transfersIn, player);
        }
        break;
      case 'selling':
        addUnique(lineup.transfersOut, player);
        break;
      // Editorial-only kinds (watching) are intentionally dropped — they
      // aren't part of a concrete lineup.
    }
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
