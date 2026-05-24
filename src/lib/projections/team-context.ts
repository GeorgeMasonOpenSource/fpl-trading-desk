import { sql } from '@/lib/db/client';

/**
 * Recompute team-level context: the PL table, end-of-season motivation, and
 * tactical-style proxies. All values are derived deterministically from the
 * finished fixtures + season totals we already store — no external data
 * source, no opinion baked in.
 *
 * Motivation logic:
 *   - Compute current PL position from points (tiebreak by GD then GF).
 *   - For each team, look at the gap (in points) to:
 *       (a) the title (position 1)
 *       (b) the top-4 cutoff (UCL spot)
 *       (c) the top-6 cutoff (European spot)
 *       (d) the relegation cutoff (position 18 line)
 *   - Number of games remaining = (38 - games_played)
 *   - A team is "motivated" if at least one of those gaps is bridgeable in
 *     the games remaining (gap ≤ 3 × games_remaining points). Once we run
 *     out of stakes, motivation collapses toward 0.10.
 *
 * Style logic:
 *   - defensive_solidity = inverse of xG conceded per match, normalised.
 *   - attacking_style    = combined high goals + high xG per match,
 *     normalised. A team that scores a lot AND concedes a lot is "open".
 */
export async function recomputeTeamContext() {
  // 1. PL table from finished fixtures
  const rows = await sql<Array<{
    team_id: number; played: number; w: number; d: number; l: number;
    gf: number; ga: number;
  }>>`
    WITH per_team AS (
      SELECT team_h AS team_id, team_h_score AS gf, team_a_score AS ga,
             CASE WHEN team_h_score > team_a_score THEN 'W'
                  WHEN team_h_score = team_a_score THEN 'D'
                  ELSE 'L' END AS outcome
      FROM fixtures WHERE finished = TRUE AND team_h_score IS NOT NULL
      UNION ALL
      SELECT team_a AS team_id, team_a_score AS gf, team_h_score AS ga,
             CASE WHEN team_a_score > team_h_score THEN 'W'
                  WHEN team_a_score = team_h_score THEN 'D'
                  ELSE 'L' END AS outcome
      FROM fixtures WHERE finished = TRUE AND team_h_score IS NOT NULL
    )
    SELECT team_id,
           COUNT(*)::int                                 AS played,
           COUNT(*) FILTER (WHERE outcome = 'W')::int    AS w,
           COUNT(*) FILTER (WHERE outcome = 'D')::int    AS d,
           COUNT(*) FILTER (WHERE outcome = 'L')::int    AS l,
           COALESCE(SUM(gf), 0)::int                     AS gf,
           COALESCE(SUM(ga), 0)::int                     AS ga
    FROM per_team
    GROUP BY team_id
  `;

  const table = rows
    .map(r => ({
      teamId: r.team_id,
      played: r.played,
      points: r.w * 3 + r.d,
      gf: r.gf,
      ga: r.ga,
      gd: r.gf - r.ga
    }))
    .sort((a, b) =>
      b.points - a.points ||
      b.gd - a.gd ||
      b.gf - a.gf
    );

  if (table.length === 0) return 0;

  const pos1Pts  = table[0]?.points ?? 0;
  const pos4Pts  = table[3]?.points ?? 0;
  const pos6Pts  = table[5]?.points ?? 0;
  const pos17Pts = table[16]?.points ?? 0;  // 18th from top = first safe spot

  // 2. Style — needs season totals from teams + goal-for/goal-against totals
  //    we just computed. League-mean as denominator for normalisation.
  const meanGa = table.reduce((s, t) => s + t.ga, 0) / table.length;
  const meanGf = table.reduce((s, t) => s + t.gf, 0) / table.length;

  // 3. Write back per team
  const updates = table.map((t, idx) => {
    const position = idx + 1;
    const gamesRemaining = Math.max(0, 38 - t.played);
    const maxBridge = gamesRemaining * 3;

    // §stakes — only OPEN-ENDED gaps count. For a team ABOVE a boundary
    // (e.g. #1 above pos2) the gap is their cushion to the chasing rival;
    // for a team BELOW it the gap is the points they'd need to bridge. A
    // stake is "live" only if abs(gap) ≤ maxBridge. If every boundary is
    // settled → motivation collapses to 0.1 ("dead rubber").
    //
    // This replaces the old "top-2 / bottom-3 floor at 0.85" override
    // which fired even when the title was mathematically decided. The
    // 25/26 GW38 case: Arsenal #1 with title secured, MCI #2 with UCL
    // secured, Wolves/Burnley already relegated all correctly return
    // 0.1 now instead of 1.0.
    const titleGap = position === 1
      ? t.points - (table[1]?.points ?? 0)        // cushion to #2
      : pos1Pts - t.points;                        // gap to title
    const top4Gap  = position <= 4
      ? t.points - (table[4]?.points ?? 0)        // cushion to #5
      : pos4Pts - t.points;                        // gap to UCL
    const top6Gap  = position <= 6
      ? t.points - (table[6]?.points ?? 0)        // cushion to #7
      : pos6Pts - t.points;                        // gap to UEL
    const relegGap = position >= 18
      ? (table[16]?.points ?? 0) - t.points       // gap to safety
      : t.points - pos17Pts;                       // cushion above the line

    const stakeCandidates: number[] = [];
    if (Math.abs(titleGap) <= maxBridge) stakeCandidates.push(Math.abs(titleGap));
    if (Math.abs(top4Gap)  <= maxBridge) stakeCandidates.push(Math.abs(top4Gap));
    if (Math.abs(top6Gap)  <= maxBridge) stakeCandidates.push(Math.abs(top6Gap));
    if (Math.abs(relegGap) <= maxBridge) stakeCandidates.push(Math.abs(relegGap));

    let motivation: number;
    if (maxBridge === 0 || stakeCandidates.length === 0) {
      motivation = 0.10;                            // nothing to play for
    } else {
      const closestGap = Math.min(...stakeCandidates);
      if (closestGap === 0)             motivation = 1.0;
      else                              motivation = 1.0 - 0.7 * (closestGap / maxBridge);
    }

    // Style proxies: solidity ~ 1 - (ga / meanGa+1), attacking ~ gf / meanGf
    const solidity = meanGa > 0 ? Math.max(0, Math.min(1, 1 - t.ga / (meanGa * 2))) : 0.5;
    const attacking = meanGf > 0 ? Math.max(0, Math.min(1, t.gf / (meanGf * 2))) : 0.5;

    return {
      teamId: t.teamId,
      position,
      points: t.points,
      played: t.played,
      gd: t.gd,
      motivation,
      solidity,
      attacking
    };
  });

  // Per-row UPDATE — teams has 20 rows, no need for bulk.
  for (const u of updates) {
    await sql`
      UPDATE teams SET
        table_position    = ${u.position},
        table_points      = ${u.points},
        games_played      = ${u.played},
        goal_difference   = ${u.gd},
        motivation_score  = ${Number(u.motivation.toFixed(3))},
        defensive_solidity = ${Number(u.solidity.toFixed(3))},
        attacking_style    = ${Number(u.attacking.toFixed(3))}
      WHERE id = ${u.teamId}
    `;
  }
  return updates.length;
}
