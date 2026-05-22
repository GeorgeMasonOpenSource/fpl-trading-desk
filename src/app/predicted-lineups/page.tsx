/**
 * Predicted Lineups
 *
 * For every Premier League team, predict the starting XI for the next
 * gameweek based on the minutes engine's `expected_minutes`. Players are
 * picked greedily: take the top N starters per position to fit a legal
 * formation (1 GK, 3-5 DEF, 2-5 MID, 1-3 FWD = 10 outfield), defaulting
 * to 4-4-2 when minutes don't strongly favour another shape.
 *
 * Per team we render:
 *   - team name + fixture + opponent style
 *   - pitch view with 11 starters (jersey + name + expected mins)
 *   - bench: next 5 players by expected minutes
 *
 * Auto-updated: the underlying `minutes_projections` table is rebuilt by
 * `recompute:all`, which runs every 2 hours via the GitHub Actions cron.
 * Just refresh the page to see the latest predictions.
 *
 * Lineup-leak override: if `ingest:lineups` ran inside the 60-min pre-KO
 * window, `minutes_projections.start_prob` will be either 1.0 (confirmed
 * starter) or 0.0 (confirmed bench / out). We use start_prob as a
 * tiebreaker within position so confirmed-XI players always sort first.
 */
import { sql } from '@/lib/db/client';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { TeamLineupPicker } from '@/components/TeamLineupPicker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function PredictedLineupsPage() {
  // Identify the next gameweek to predict for. Prefer is_next; fall back
  // to is_current; absolute fallback is the smallest unfinished GW.
  const gwRows = await sql<Array<{ id: number; name: string }>>`
    SELECT id, name FROM gameweeks
     WHERE is_next = TRUE OR is_current = TRUE OR finished = FALSE
     ORDER BY is_next DESC, is_current DESC, id ASC
     LIMIT 1
  `;
  const gw = gwRows[0];
  if (!gw) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Predicted Lineups</h1>
        <p className="text-ink-muted">No gameweek data yet — run db:seed.</p>
      </div>
    );
  }

  // Pull every team + their next fixture (home/away + opponent + kickoff).
  const fixtureRows = await sql<Array<{
    team_id: number; team_name: string; team_short: string;
    fixture_id: number; opponent_id: number; opponent_short: string;
    is_home: boolean; kickoff_time: string | Date | null;
  }>>`
    WITH fx AS (
      SELECT f.id, f.team_h, f.team_a, f.kickoff_time, f.event
        FROM fixtures f
       WHERE f.event = ${gw.id} AND f.finished = FALSE
    )
    SELECT t.id        AS team_id,
           t.name      AS team_name,
           t.short_name AS team_short,
           fx.id       AS fixture_id,
           CASE WHEN fx.team_h = t.id THEN fx.team_a ELSE fx.team_h END AS opponent_id,
           CASE WHEN fx.team_h = t.id THEN ta.short_name ELSE th.short_name END AS opponent_short,
           (fx.team_h = t.id)::boolean AS is_home,
           fx.kickoff_time
      FROM teams t
      JOIN fx       ON fx.team_h = t.id OR fx.team_a = t.id
      LEFT JOIN teams th ON th.id = fx.team_h
      LEFT JOIN teams ta ON ta.id = fx.team_a
     ORDER BY t.name
  `;

  // Pull every player on those teams with their expected minutes for the
  // fixture. One row per (player, fixture). The minutes engine writes a
  // row per fixture-in-gameweek per player, so for single-GW teams that's
  // 1 row per player. We aggregate to MAX in case of doubles.
  const playerRows = await sql<Array<{
    player_id: number; web_name: string; first_name: string;
    position: 'GKP' | 'DEF' | 'MID' | 'FWD';
    team_id: number;
    expected_minutes: number;
    start_prob: number;
    sixty_plus_prob: number;
    status: string;
    chance_of_playing_next_round: number | null;
    xpts: number;
  }>>`
    SELECT p.id        AS player_id,
           p.web_name,
           p.first_name,
           p.position,
           p.team_id,
           COALESCE(MAX(mn.expected_minutes), 0)::float8  AS expected_minutes,
           COALESCE(MAX(mn.start_prob), 0)::float8        AS start_prob,
           COALESCE(MAX(mn.sixty_plus_prob), 0)::float8   AS sixty_plus_prob,
           p.status,
           p.chance_of_playing_next_round,
           COALESCE(MAX(pr.xpts_total), 0)::float8        AS xpts
      FROM players p
      LEFT JOIN minutes_projections mn ON mn.player_id = p.id
        AND mn.fixture_id IN (SELECT id FROM fixtures WHERE event = ${gw.id})
      LEFT JOIN projections pr ON pr.player_id = p.id AND pr.gameweek_id = ${gw.id}
     WHERE p.status <> 'u'
     GROUP BY p.id
  `;

  // Group by team, then pick the predicted XI per team:
  //   1. GK = top-1 by start_prob then expected_minutes
  //   2. Outfielders: fill 10 slots respecting min/max per position
  //      (3-5 DEF, 2-5 MID, 1-3 FWD). Use simple greedy: sort all by
  //      expected_minutes desc, take in order until each position hits
  //      its min, then fill remaining slots from the top of the pool.
  // playerRows is a postgres.js RowList<T[]>; convert to a plain T[] so
  // we can use Map<number, T[]> without RowList type clashes.
  type PlayerRow = (typeof playerRows)[number];
  const players: PlayerRow[] = Array.from(playerRows);
  const teamsToPlayers = new Map<number, PlayerRow[]>();
  for (const p of players) {
    if (!teamsToPlayers.has(p.team_id)) teamsToPlayers.set(p.team_id, []);
    teamsToPlayers.get(p.team_id)!.push(p);
  }

  type Predicted = {
    teamId: number;
    teamName: string;
    teamShort: string;
    opponentShort: string;
    isHome: boolean;
    kickoffTime: string | null;
    starters: PlayerRow[];
    bench: PlayerRow[];
  };

  const predicted: Predicted[] = [];
  for (const f of fixtureRows) {
    const ranked = (teamsToPlayers.get(f.team_id) ?? [])
      .slice()
      .sort((a, b) => {
        // Confirmed XI (start_prob >= 0.99) wins; then expected_minutes.
        if ((a.start_prob >= 0.99) !== (b.start_prob >= 0.99)) {
          return a.start_prob >= 0.99 ? -1 : 1;
        }
        return Number(b.expected_minutes) - Number(a.expected_minutes);
      });
    const xi = pickStartingXI(ranked);
    const benchOrdered = ranked.filter(p => !xi.includes(p)).slice(0, 5);
    predicted.push({
      teamId: f.team_id,
      teamName: f.team_name,
      teamShort: f.team_short,
      opponentShort: f.opponent_short,
      isHome: f.is_home,
      kickoffTime: f.kickoff_time
        ? (f.kickoff_time instanceof Date ? f.kickoff_time.toISOString() : String(f.kickoff_time))
        : null,
      starters: xi,
      bench: benchOrdered
    });
  }
  predicted.sort((a, b) => a.teamName.localeCompare(b.teamName));

  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Predicted lineups</div>
        <h1 className="text-2xl font-semibold">{gw.name} — predicted starting XIs</h1>
        <p className="text-sm text-ink-muted mt-1">
          Built from the minutes engine&apos;s <span className="font-mono">expected_minutes</span>{' '}
          per player. Confirmed-XI overrides flow in automatically once FotMob
          publishes (60 min pre-KO). Auto-refreshed every 2 hours via the
          ingest-model GitHub Actions cron.
        </p>
        <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-mono text-ink-dim">
          <Badge tone="green">CONFIRMED</Badge>
          <span>= FotMob has published this XI</span>
          <span className="mx-2">·</span>
          <Badge tone="steel">PREDICTED</Badge>
          <span>= our model&apos;s best guess from rotation patterns</span>
        </div>
      </header>

      <TeamLineupPicker predicted={predicted} />
    </div>
  );
}

/**
 * Greedy XI builder. Takes a position-sorted player list (already sorted
 * desc by start_prob then expected_minutes), returns the 11 players we
 * predict will start.
 *
 * Formation logic: most teams default to 4-3-3 in the EPL this season,
 * but we let the data shape pick: if 5 defenders have higher expected
 * minutes than the 3rd MID then we go 5-3-2 etc. The constraint is
 * legal football (1 GK, 3-5 DEF, 2-5 MID, 1-3 FWD, totalling 11).
 */
function pickStartingXI<T extends { position: 'GKP' | 'DEF' | 'MID' | 'FWD'; expected_minutes: number; start_prob: number }>(
  sorted: T[]
): T[] {
  const gk = sorted.find(p => p.position === 'GKP');
  const out = sorted.filter(p => p.position !== 'GKP');
  // Categorise the top candidates by position
  const defs = out.filter(p => p.position === 'DEF');
  const mids = out.filter(p => p.position === 'MID');
  const fwds = out.filter(p => p.position === 'FWD');

  // Start with minimums (3 DEF, 2 MID, 1 FWD = 6 outfield) plus the GK.
  const picked: T[] = [];
  if (gk) picked.push(gk);
  picked.push(...defs.slice(0, 3));
  picked.push(...mids.slice(0, 2));
  picked.push(...fwds.slice(0, 1));

  // Fill the remaining 4 slots greedily from the leftover pool, respecting
  // the maxima (5 DEF, 5 MID, 3 FWD).
  const counts: Record<'DEF' | 'MID' | 'FWD', number> = {
    DEF: 3, MID: 2, FWD: 1
  };
  const maxima: Record<'DEF' | 'MID' | 'FWD', number> = {
    DEF: 5, MID: 5, FWD: 3
  };
  const pool = out
    .filter(p => !picked.includes(p))
    .sort((a, b) => Number(b.expected_minutes) - Number(a.expected_minutes));
  for (const p of pool) {
    if (picked.length >= 11) break;
    const pos = p.position as 'DEF' | 'MID' | 'FWD';
    if (counts[pos] < maxima[pos]) {
      picked.push(p);
      counts[pos] += 1;
    }
  }
  return picked.slice(0, 11);
}
