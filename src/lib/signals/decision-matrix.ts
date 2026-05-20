import { sql } from '@/lib/db/client';
import { getSignalValidations, alignVerdictToKind, type Verdict } from './validation';

/**
 * Decision Matrix — bucket every pending creator signal into one of four
 * actionable cells, plus a fifth "blind spots" panel.
 *
 *                    │ Model AGREES         │ Model DISAGREES
 *   ─────────────────┼──────────────────────┼─────────────────────
 *   Creators BUYING  │ STRONG BUY           │ EXPERT EDGE
 *   (buying /        │ ─ both say go in     │ ─ creators see something
 *    recommend)      │                      │   the model doesn't (yet)
 *   ─────────────────┼──────────────────────┼─────────────────────
 *   Creators SELLING │ STRONG SELL          │ MODEL EDGE
 *   (selling /       │ ─ both say cut       │ ─ we say hold, creators
 *    bench)          │                      │   say sell — bargain ahead?
 *
 *   BLIND SPOTS (fifth panel): players in the top 30 by next-3-GW model
 *   xPts that have ZERO creator buying signals on the board. The model
 *   rates them but creators aren't talking — easy to miss.
 *
 * The model verdict is the same one shown on the Creator Board, computed
 * by getSignalValidations (position-percentile of 3-GW xPts). To say the
 * model and creator AGREE on a buy, we require the player to be in the
 * top quartile for their position (verdict='agrees') AND the signal kind
 * to be on the buy side ('buying' or 'recommend').
 *
 * Roll-ups: a player can have multiple signals across creators. We keep
 * one row per player per bucket, summarising creators + signal count.
 */

// Only ACTIONABLE intent kinds, not team-selection commentary.
//
//   `start` and `bench` are factual claims about a player's MATCHDAY status
//   (X will start, X is on the bench), not a buy/sell recommendation. They
//   live on the Manager Quotes tab of the Creator Board where they belong.
//   Including them here was flooding Strong BUYs with "Tavernier will start"
//   and similar team-news lines.
//
//   `recommend` = "must own / love / great pick" → genuine buy advice.
//   `buying`    = explicit transfer-in intent.
//   `selling`   = explicit transfer-out intent.
const BUY_KINDS = new Set(['buying', 'recommend']);
const SELL_KINDS = new Set(['selling']);

export interface DecisionMatrixEntry {
  playerId: number;
  webName: string;
  position: 'GKP' | 'DEF' | 'MID' | 'FWD';
  teamShort: string;
  nowCost: number;
  // Creator-side
  signalKinds: string[];            // distinct kinds across this player's signals
  creatorNames: string[];           // distinct channel names
  signalCount: number;              // total signals (sum across creators)
  topQuote: { text: string; channel: string; url: string; videoId: string; ts: number } | null;
  // Model-side
  xpts3: number;                    // next 3 GW xPts (summed)
  positionRank: number;             // 1 = best at position
  positionCount: number;
  verdict: Verdict;                 // raw model verdict (top quartile etc.)
  // Owned in current squad?
  owned: boolean;
}

export interface DecisionMatrix {
  startGameweek: number;
  strongBuys: DecisionMatrixEntry[];
  expertEdge: DecisionMatrixEntry[];
  modelEdge: DecisionMatrixEntry[];
  strongSells: DecisionMatrixEntry[];
  blindSpots: DecisionMatrixEntry[];   // top-xPts players with no creator buys
}

interface SignalRow {
  player_id: number;
  web_name: string;
  position: 'GKP' | 'DEF' | 'MID' | 'FWD';
  team_short: string;
  now_cost: number;
  signal_kind: string;
  channel_name: string;
  raw_quote: string;
  video_id: string;
  video_url: string;
  timestamp_sec: number;
  confidence: number;
  owned: boolean;
}

export async function getDecisionMatrix(
  managerId: number | null,
  startGameweek: number
): Promise<DecisionMatrix> {
  // 1. All pending signals on the board, joined to player + team + video.
  const rows = await sql<SignalRow[]>`
    SELECT s.player_id, p.web_name, p.position,
           t.short_name AS team_short,
           p.now_cost,
           s.signal_kind, s.raw_quote, s.timestamp_sec, s.confidence,
           v.channel_name, v.video_id, v.url AS video_url,
           ${managerId == null ? sql`FALSE` : sql`EXISTS (
             SELECT 1 FROM manager_picks mp
              WHERE mp.manager_id = ${managerId}
                AND mp.player_id = s.player_id
                AND mp.gameweek_id IN (
                  SELECT id FROM gameweeks WHERE is_current OR is_next
                )
           )`} AS owned
      FROM transcript_signals s
      JOIN players p   ON p.id = s.player_id
      JOIN teams t     ON t.id = p.team_id
      JOIN youtube_videos v ON v.video_id = s.video_id
     WHERE s.user_action IS NULL
       AND v.published_at > now() - INTERVAL '14 days'
  `;
  if (rows.length === 0) {
    return { startGameweek, strongBuys: [], expertEdge: [], modelEdge: [], strongSells: [], blindSpots: [] };
  }

  // 2. Validate every distinct player against the model.
  const distinctPlayerIds = Array.from(new Set(rows.map(r => r.player_id)));
  const validations = await getSignalValidations(distinctPlayerIds, startGameweek);

  // 3. Group rows by (player, side). A player can appear in multiple
  //    buckets if their signals span both sides — we keep that, on the
  //    grounds that disagreement among creators IS the signal.
  type SideKey = 'buy' | 'sell';
  const groupedByPlayer = new Map<number, {
    sides: Map<SideKey, SignalRow[]>;
    head: SignalRow;       // first row, used for player metadata
  }>();
  for (const r of rows) {
    const side: SideKey | null =
      BUY_KINDS.has(r.signal_kind)  ? 'buy'  :
      SELL_KINDS.has(r.signal_kind) ? 'sell' :
      null;  // editorial-only kinds like 'watching' don't go in the matrix
    if (!side) continue;
    if (!groupedByPlayer.has(r.player_id)) {
      groupedByPlayer.set(r.player_id, { sides: new Map(), head: r });
    }
    const grp = groupedByPlayer.get(r.player_id)!;
    if (!grp.sides.has(side)) grp.sides.set(side, []);
    grp.sides.get(side)!.push(r);
  }

  // 4. Build each quadrant entry.
  const strongBuys: DecisionMatrixEntry[] = [];
  const expertEdge: DecisionMatrixEntry[] = [];
  const modelEdge: DecisionMatrixEntry[] = [];
  const strongSells: DecisionMatrixEntry[] = [];

  for (const grp of groupedByPlayer.values()) {
    const v = validations.get(grp.head.player_id);
    if (!v || v.verdict === 'no_data') continue;

    for (const [side, sigRows] of grp.sides.entries()) {
      // Use the first row's kind as the representative to align verdict.
      // For 'buy' side this means we want top-quartile → agrees.
      // For 'sell' side we want bottom-quartile → still agrees after
      // alignVerdictToKind has flipped it.
      const repKind = side === 'buy' ? 'buying' : 'selling';
      const aligned = alignVerdictToKind(v.verdict, repKind);

      const entry = buildEntry(grp.head, sigRows, v);

      if (side === 'buy' && aligned === 'agrees')      strongBuys.push(entry);
      else if (side === 'buy' && aligned === 'disagrees')  expertEdge.push(entry);
      else if (side === 'sell' && aligned === 'agrees') strongSells.push(entry);
      else if (side === 'sell' && aligned === 'disagrees') modelEdge.push(entry);
    }
  }

  // 5. Sort each quadrant. Strong buys / sells: most-endorsed first
  //    (creators count desc, signal count desc, then xpts3 desc).
  //    Edges: by xpts3 desc so the model's strongest opinions float up.
  const byEndorsement = (a: DecisionMatrixEntry, b: DecisionMatrixEntry) =>
    b.creatorNames.length - a.creatorNames.length ||
    b.signalCount - a.signalCount ||
    b.xpts3 - a.xpts3;
  const byXpts = (a: DecisionMatrixEntry, b: DecisionMatrixEntry) =>
    b.xpts3 - a.xpts3 || b.signalCount - a.signalCount;
  strongBuys.sort(byEndorsement);
  expertEdge.sort(byXpts);
  modelEdge.sort(byXpts);
  strongSells.sort(byEndorsement);

  // 6. Filter by ownership status, per quadrant. Logic:
  //    - BUY quadrants: drop players already in the squad. Suggesting we
  //      "buy" someone you own is noise — you can't buy them again.
  //    - SELL quadrants: keep ONLY owned players. You can only sell what
  //      you own; selling Salah doesn't help if he's not in your team.
  //    - Blind spots: drop owned (these are candidates to add).
  //
  // When no manager is connected we skip the filter entirely so an
  // anonymous viewer still sees the full matrix.
  const filterUnowned = (list: DecisionMatrixEntry[]) =>
    managerId == null ? list : list.filter(e => !e.owned);
  const filterOwned   = (list: DecisionMatrixEntry[]) =>
    managerId == null ? list : list.filter(e =>  e.owned);
  const strongBuysFiltered  = filterUnowned(strongBuys);
  const expertEdgeFiltered  = filterUnowned(expertEdge);
  const modelEdgeFiltered   = filterOwned(modelEdge);
  const strongSellsFiltered = filterOwned(strongSells);

  // 7. Blind spots: top 30 xPts players for the next 3 GW that have
  //    NO buy-side signal in the matrix (after the ownership filter).
  //    Excludes players already in any quadrant on the buy side OR
  //    in the user's squad — they aren't blind spots if you already own them.
  const buyerIds = new Set([
    ...strongBuysFiltered.map(e => e.playerId),
    ...expertEdgeFiltered.map(e => e.playerId)
  ]);
  const blindSpots = await loadBlindSpots(buyerIds, startGameweek, managerId);
  const blindSpotsFiltered = managerId == null
    ? blindSpots
    : blindSpots.filter(e => !e.owned);

  return {
    startGameweek,
    strongBuys:  strongBuysFiltered,
    expertEdge:  expertEdgeFiltered,
    modelEdge:   modelEdgeFiltered,
    strongSells: strongSellsFiltered,
    blindSpots:  blindSpotsFiltered
  };
}

function buildEntry(
  head: SignalRow,
  rows: SignalRow[],
  v: { verdict: Verdict; modelXpts: number; positionRank: number; positionCount: number }
): DecisionMatrixEntry {
  // Highest-confidence quote becomes the topQuote shown on the card.
  const best = rows.slice().sort((a, b) => b.confidence - a.confidence)[0]!;
  const channels = Array.from(new Set(rows.map(r => r.channel_name)));
  const kinds = Array.from(new Set(rows.map(r => r.signal_kind)));
  return {
    playerId: head.player_id,
    webName: head.web_name,
    position: head.position,
    teamShort: head.team_short,
    nowCost: Number(head.now_cost),
    signalKinds: kinds,
    creatorNames: channels,
    signalCount: rows.length,
    topQuote: {
      text: best.raw_quote,
      channel: best.channel_name,
      url: `${best.video_url}&t=${best.timestamp_sec}s`,
      videoId: best.video_id,
      ts: best.timestamp_sec
    },
    xpts3: v.modelXpts,
    positionRank: v.positionRank,
    positionCount: v.positionCount,
    verdict: v.verdict,
    owned: head.owned
  };
}

/**
 * Top-xPts players with no creator signals on the board. These are
 * potential moves the model rates but the creator pool hasn't surfaced.
 */
async function loadBlindSpots(
  excludedIds: Set<number>,
  startGameweek: number,
  managerId: number | null
): Promise<DecisionMatrixEntry[]> {
  const excludeArr = excludedIds.size > 0 ? Array.from(excludedIds) : [-1];
  const rows = await sql<Array<{
    player_id: number; web_name: string;
    position: 'GKP' | 'DEF' | 'MID' | 'FWD';
    team_short: string; now_cost: number;
    xpts_3: number;
    owned: boolean;
  }>>`
    WITH proj AS (
      SELECT player_id,
             SUM(CASE WHEN gameweek_id BETWEEN ${startGameweek} AND ${startGameweek} + 2
                      THEN xpts_total ELSE 0 END) AS xpts_3
        FROM projections
       GROUP BY player_id
    )
    SELECT p.id AS player_id, p.web_name, p.position,
           t.short_name AS team_short,
           p.now_cost,
           COALESCE(proj.xpts_3, 0) AS xpts_3,
           ${managerId == null ? sql`FALSE` : sql`EXISTS (
             SELECT 1 FROM manager_picks mp
              WHERE mp.manager_id = ${managerId}
                AND mp.player_id = p.id
                AND mp.gameweek_id IN (
                  SELECT id FROM gameweeks WHERE is_current OR is_next
                )
           )`} AS owned
      FROM players p
      JOIN teams t ON t.id = p.team_id
      LEFT JOIN proj ON proj.player_id = p.id
     WHERE p.status = 'a'
       AND COALESCE(p.season_minutes, 0) > 270
       AND p.id NOT IN ${sql(excludeArr as any)}
     ORDER BY proj.xpts_3 DESC NULLS LAST
     LIMIT 30
  `;
  // Fill in shape parity with quadrant entries even though there are no
  // creator signals here. The UI hides the creator-side columns for
  // blind spots and shows model rank + xPts instead.
  return rows.map(r => ({
    playerId: r.player_id,
    webName: r.web_name,
    position: r.position,
    teamShort: r.team_short,
    nowCost: Number(r.now_cost),
    signalKinds: [],
    creatorNames: [],
    signalCount: 0,
    topQuote: null,
    xpts3: Number(r.xpts_3),
    positionRank: 0,         // not computed here — column hidden in UI
    positionCount: 0,
    verdict: 'agrees',       // by construction (top of board)
    owned: !!r.owned
  }));
}
