/**
 * Gameweek filter for YouTube ingest.
 *
 * Problem: at any given moment, FPL channels are sitting on a mix of videos
 *   - some about the PREVIOUS gameweek that just finished (deadline-day live
 *     streams, post-match wrap-ups)
 *   - some about the UPCOMING gameweek (team selections, transfer plans)
 * Both kinds show up in their RSS feed, and the previous-GW content's
 * "buy X / start Y" signals are stale by the time we'd act on them.
 *
 * Solution: parse the GW number out of the video title. If the title clearly
 * targets a gameweek other than the planning GW, we skip the transcript
 * fetch entirely and stamp transcript_status = 'skipped_old_gw'.
 *
 * Titles WITHOUT a GW marker (general-purpose content like "FPL Players To
 * Watch Next Season") are KEPT — those might still produce useful editorial
 * signals like long-term holds. The filter is conservative on purpose.
 */

/**
 * Extract a gameweek number from a YouTube title. Returns null if nothing
 * matched — caller treats null as "general content, process anyway".
 *
 * Patterns we accept (case-insensitive):
 *   - "GW38"      → 38
 *   - "GW 38"     → 38
 *   - "gw38"      → 38
 *   - "Gameweek 38" → 38
 *   - "GW 38:"    → 38
 *
 * Patterns we deliberately DON'T accept (too noisy):
 *   - "double gameweek" without a number — no clear target
 *   - "week 38" — clashes with non-FPL content
 */
export function extractGwFromTitle(title: string): number | null {
  if (!title) return null;
  // Greedy match — find the FIRST GW reference. Some titles say "GW37 vs
  // GW38" (a comparison video). For those we take GW37 and let the user
  // decide whether to keep — most "GW37 vs GW38" content is a retrospective.
  const re = /\b(?:gw|gameweek)\s*(\d{1,2})\b/i;
  const m = title.match(re);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1 || n > 38) return null;
  return n;
}

export type GwFilterDecision =
  | { keep: true;  reason: 'no_gw_marker' | 'matches_planning' | 'within_lookback' }
  | { keep: false; reason: 'old_gw'; videoGw: number; planningGw: number };

/**
 * Decide whether to process a video.
 *
 * Rules:
 *   - No GW in title         → keep (general content)
 *   - GW matches planning GW → keep
 *   - GW within `lookback` of planning → keep (the channel might have a
 *     same-week video tagged with last week's marker by mistake; rare but
 *     happens with reshares). Default lookback = 0.
 *   - Otherwise              → skip with old_gw reason.
 */
export function decideGwFilter(
  title: string,
  planningGw: number | null,
  lookback = 0
): GwFilterDecision {
  if (planningGw == null) return { keep: true, reason: 'no_gw_marker' };
  const videoGw = extractGwFromTitle(title);
  if (videoGw == null) return { keep: true, reason: 'no_gw_marker' };
  if (videoGw === planningGw) return { keep: true, reason: 'matches_planning' };
  if (lookback > 0 && videoGw >= planningGw - lookback && videoGw <= planningGw) {
    return { keep: true, reason: 'within_lookback' };
  }
  return { keep: false, reason: 'old_gw', videoGw, planningGw };
}
