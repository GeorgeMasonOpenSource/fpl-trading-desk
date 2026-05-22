import { sql } from '@/lib/db/client';

/**
 * Match-state captain re-rank.
 *
 * Once the first match of the gameweek kicks off, FPLReview's numbers
 * are frozen. Ours can adapt: if your current captain has already
 * blanked (0 minutes), or if your vice is in a 5-0 thrashing at HT, the
 * "captain pick" is now a live decision (well, almost — FPL captain
 * change locks at lineup release).
 *
 * What this surfaces:
 *   - For each candidate captain in the user's XI, the live points so
 *     far (from `player_gameweek_history` populated by the live cron)
 *   - A "remaining xPts" estimate for players whose match is still
 *     ongoing or yet to start
 *   - Their TOTAL projected captain points (live + remaining) × 2
 *   - The best alternative given current information
 *
 * FPL allows captain changes up to the deadline of the first fixture you
 * have a player in, BUT crucially the auto-captain (if your C blanks <60
 * mins) goes to your V. So even when manual change is locked, this view
 * helps you understand whether your V is in a good fixture and is starting.
 */

export interface MatchStateCaptain {
  playerId: number;
  webName: string;
  position: string;
  teamShort: string;
  // Status of this player's match.
  matchStatus: 'not_started' | 'in_progress' | 'finished';
  livePoints: number | null;       // null when match not started
  minutesPlayed: number;
  // Remaining expected points for the rest of their match (0 if finished).
  remainingExpected: number;
  // Total live + remaining, doubled (captain).
  totalCaptainPts: number;
  isCurrentCaptain: boolean;
  isCurrentVice: boolean;
}

export async function getMatchStateCaptains(
  managerId: number,
  gameweekId: number
): Promise<{ ranked: MatchStateCaptain[]; recommended: MatchStateCaptain | null }> {
  const rows = await sql<Array<{
    player_id: number;
    web_name: string; position: string; team_short: string;
    is_captain: boolean; is_vice: boolean;
    minutes: number | null;
    live_points: number | null;
    fixture_finished: boolean | null;
    kickoff_time: Date | string | null;
    xpts_total: number | null;
  }>>`
    SELECT mp.player_id,
           p.web_name, p.position, t.short_name AS team_short,
           mp.is_captain, mp.is_vice,
           pgh.minutes,
           pgh.total_points AS live_points,
           f.finished AS fixture_finished,
           f.kickoff_time,
           COALESCE(pr.xpts_total, 0)::float8 AS xpts_total
      FROM manager_picks mp
      JOIN players p ON p.id = mp.player_id
      JOIN teams   t ON t.id = p.team_id
      LEFT JOIN player_gameweek_history pgh
        ON pgh.player_id = mp.player_id AND pgh.gameweek_id = mp.gameweek_id
      LEFT JOIN fixtures f
        ON f.id = pgh.fixture_id
      LEFT JOIN projections pr
        ON pr.player_id = mp.player_id AND pr.gameweek_id = mp.gameweek_id
     WHERE mp.manager_id = ${managerId}
       AND mp.gameweek_id = ${gameweekId}
       AND mp.position <= 11
  `;

  const now = Date.now();
  const out: MatchStateCaptain[] = rows.map(r => {
    let matchStatus: MatchStateCaptain['matchStatus'] = 'not_started';
    if (r.fixture_finished) matchStatus = 'finished';
    else if (r.kickoff_time) {
      const kt = new Date(r.kickoff_time as any).getTime();
      if (kt <= now) matchStatus = 'in_progress';
    }
    const livePts = r.live_points == null ? null : Number(r.live_points);
    const minutesPlayed = Number(r.minutes ?? 0);
    const xpts = Number(r.xpts_total ?? 0);

    // Remaining xPts: scale projected by (90 - minutes_played)/90 when in-progress.
    let remainingExpected = 0;
    if (matchStatus === 'not_started') remainingExpected = xpts;
    else if (matchStatus === 'in_progress') {
      remainingExpected = xpts * Math.max(0, (90 - minutesPlayed) / 90);
    }

    const liveContribution = livePts ?? 0;
    const totalCaptainPts = (liveContribution + remainingExpected) * 2;

    return {
      playerId: r.player_id,
      webName:  r.web_name,
      position: r.position,
      teamShort: r.team_short,
      matchStatus,
      livePoints: livePts,
      minutesPlayed,
      remainingExpected,
      totalCaptainPts,
      isCurrentCaptain: r.is_captain,
      isCurrentVice: r.is_vice
    };
  });

  out.sort((a, b) => b.totalCaptainPts - a.totalCaptainPts);
  return { ranked: out, recommended: out[0] ?? null };
}
