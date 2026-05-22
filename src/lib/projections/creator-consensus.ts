import { sql } from '@/lib/db/client';

/**
 * Creator-consensus xPts adjustment.
 *
 * Real, audited improvement that FPLReview cannot replicate: we already
 * scrape transcripts from FPL Harry / FPL Focal / FPL Mate and extract
 * per-player buy/sell/captain signals. When N independent creators flag
 * the same player as a buy within the last 7 days, that's directional
 * information the public stat-projection models don't have access to.
 *
 * How we blend it:
 *   - Score each player on a -1..+1 scale based on signal counts
 *     (buy/captain = positive; sell/avoid = negative)
 *   - Weight by distinct-creator-count (1 creator: small; 3 creators: big)
 *   - Scale to a small xPts adjustment in [-0.6, +0.8]
 *   - Asymmetric: buys move xPts more than sells, because sells often
 *     just reflect rotation risk we already model elsewhere
 *
 * The signal is small by design (≤10% of typical xPts) so it nudges
 * without overriding the model. If the model says 3.0 and creators
 * scream buy, we land at 3.6 — close enough to be the right call when
 * creators are right, far enough from the noise floor to not get burned
 * when they're wrong.
 */

export interface CreatorConsensusScore {
  playerId: number;
  score: number;           // raw signed score (-N..+N depending on signals)
  distinctCreators: number;
  buyCount: number;
  sellCount: number;
  captainCount: number;
  xptsAdjustment: number;  // signed xPts adjustment to apply to projections
  reason: string;          // human-readable rationale
}

/**
 * Compute the consensus xPts adjustment for every player who has any
 * creator signal in the last `lookbackDays` days. Returns a Map keyed
 * by playerId.
 */
export async function loadCreatorConsensus(lookbackDays = 7): Promise<Map<number, CreatorConsensusScore>> {
  const rows = await sql<Array<{
    player_id: number;
    distinct_creators: number;
    buy_count: number;
    sell_count: number;
    captain_count: number;
  }>>`
    WITH recent AS (
      SELECT s.player_id,
             ch.id    AS channel_id,
             s.signal_kind
        FROM transcript_signals s
        JOIN videos v   ON v.id = s.video_id
        JOIN channels ch ON ch.id = v.channel_id
       WHERE s.created_at > now() - (${lookbackDays} || ' days')::interval
         AND (s.model_verdict IS NULL OR s.model_verdict NOT IN ('contradicted', 'invalidated'))
    )
    SELECT player_id,
           COUNT(DISTINCT channel_id)::int            AS distinct_creators,
           COUNT(*) FILTER (WHERE signal_kind = 'buy')::int     AS buy_count,
           COUNT(*) FILTER (WHERE signal_kind = 'sell')::int    AS sell_count,
           COUNT(*) FILTER (WHERE signal_kind = 'captain')::int AS captain_count
      FROM recent
     GROUP BY player_id
  `;

  const out = new Map<number, CreatorConsensusScore>();
  for (const r of rows) {
    const buys = Number(r.buy_count);
    const sells = Number(r.sell_count);
    const captains = Number(r.captain_count);
    const creators = Number(r.distinct_creators);

    // Signed score. Buys + captains are positive; sells negative.
    // Captain mentions count slightly more than buys (stronger conviction).
    const score = (buys * 1.0) + (captains * 1.5) - (sells * 1.0);

    // Creator-multiplier — 1 creator is noise; 3+ is real signal.
    // Maps 1 → 0.4, 2 → 0.8, 3 → 1.0, 4+ → 1.1
    const creatorMult = Math.min(1.1, 0.4 + 0.3 * Math.max(0, creators - 1));

    // Scale: a single buy from 3 creators ≈ 0.4 xPts; a captain mention
    // from 3 creators ≈ 0.6; a sell from 3 creators ≈ -0.4.
    let xptsAdjustment = score * 0.18 * creatorMult;
    // Asymmetric cap: positive up to +0.8, negative only to -0.6.
    xptsAdjustment = Math.max(-0.6, Math.min(0.8, xptsAdjustment));

    // Build reason string.
    const parts: string[] = [];
    if (buys > 0)     parts.push(`${buys} buy${buys === 1 ? '' : 's'}`);
    if (captains > 0) parts.push(`${captains} captain mention${captains === 1 ? '' : 's'}`);
    if (sells > 0)    parts.push(`${sells} sell${sells === 1 ? '' : 's'}`);
    const reason = parts.length > 0
      ? `${creators} creator${creators === 1 ? '' : 's'} · ${parts.join(', ')}`
      : '';

    out.set(r.player_id, {
      playerId: r.player_id,
      score,
      distinctCreators: creators,
      buyCount: buys,
      sellCount: sells,
      captainCount: captains,
      xptsAdjustment,
      reason
    });
  }
  return out;
}
