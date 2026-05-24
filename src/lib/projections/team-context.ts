import { sql } from '@/lib/db/client';

/**
 * Parse the EU-qualification env config. Defaults reflect 25/26 reality:
 *   • UCL: 5 league slots (England has UEFA coefficient bonus this cycle)
 *   • UEL: 1 league slot (the other UEL spot goes to the EFL/FA cup winner)
 *   • UECL: 1 league slot
 *   • Trophy pre-qualifiers: AVL (UEL winner — already in next UCL),
 *     CRY (UECL final — UECL slot if they win). Override via env to
 *     reflect actual results.
 */
interface EuConfig {
  uclLeagueSlots:  number;
  uelLeagueSlots:  number;
  ueclLeagueSlots: number;
  uclByTrophy:    string[];   // upper-case short_names
  uelByTrophy:    string[];
}

function parseEuConfig(): EuConfig {
  const num = (k: string, def: number) => {
    const v = Number(process.env[k]);
    return Number.isFinite(v) && v >= 0 ? v : def;
  };
  const list = (k: string, def: string[]) => {
    const raw = process.env[k];
    if (!raw) return def;
    return raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  };
  return {
    uclLeagueSlots:  num('EU_UCL_LEAGUE_SLOTS',  5),
    uelLeagueSlots:  num('EU_UEL_LEAGUE_SLOTS',  1),
    ueclLeagueSlots: num('EU_UECL_LEAGUE_SLOTS', 1),
    uclByTrophy:    list('EU_UCL_QUALIFIED_BY_TROPHY', ['AVL']),
    uelByTrophy:    list('EU_UEL_QUALIFIED_BY_TROPHY', []),
  };
}

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

  // §EU-slot config — varies year to year and depends on whether English
  // clubs win European cups. Defaults to 25/26 reality:
  //   • UCL: top-5 (England has the UEFA coefficient bonus this cycle)
  //   • UEL: position 6 unless a PL cup winner has pre-qualified for it
  //     (e.g. FA Cup winner gets UEL — frees the league spot up by one if
  //      they would otherwise have been outside the EU places).
  //   • UECL: position 7 (or 6 if FA Cup winner is in top-6 etc.)
  //   • Already-qualified PL teams (e.g. UEL winner Aston Villa locked
  //     into next-season UCL by trophy alone) DON'T consume a league EU
  //     spot. The user lists them via env so we compute the right boundary.
  //
  // Env override format (comma-separated team short_names):
  //   EU_UCL_QUALIFIED_BY_TROPHY=AVL,CHE      // these teams in UCL via cup
  //   EU_UEL_QUALIFIED_BY_TROPHY=CRY          // these teams in UEL via FA Cup
  //   EU_UCL_LEAGUE_SLOTS=5                   // default 5 (coefficient era)
  //   EU_UEL_LEAGUE_SLOTS=1                   // default 1 (after PL cup spot)
  //   EU_UECL_LEAGUE_SLOTS=1                  // default 1
  const eu = parseEuConfig();
  const trophyPreQualifiedIds = new Set<number>();
  {
    const shorts = new Set<string>([...eu.uclByTrophy, ...eu.uelByTrophy]);
    if (shorts.size > 0) {
      const rows = await sql<Array<{ id: number; short_name: string }>>`
        SELECT id, short_name FROM teams
      `;
      for (const r of rows) {
        if (shorts.has(r.short_name.toUpperCase())) trophyPreQualifiedIds.add(r.id);
      }
    }
  }

  // League EU thresholds, adjusted for trophy pre-qualifiers. If Villa
  // (already in UCL via UEL win) finishes in the top-5 league places, the
  // league's 5th UCL slot "cascades" — 6th gets it, and so on. We compute
  // the BOUNDARY positions dynamically by walking the table skipping any
  // team that's already trophy-qualified.
  const orderedTeamIds = table.map(t => t.teamId);
  const tIdToPts = new Map(table.map((t, i) => [t.teamId, t.points] as const));
  // Build the eligible-for-league-EU list (excluding trophy-prequal teams).
  const leagueEligibleIds = orderedTeamIds.filter(id => !trophyPreQualifiedIds.has(id));
  // Compute the actual UCL / UEL / UECL boundary points (the LAST team to
  // qualify under each comp). Falls back to top-of-list if fewer eligible
  // teams than slots — defensive.
  const boundaryPoints = (slot: number): number => {
    if (slot <= 0 || leagueEligibleIds.length === 0) return Number.POSITIVE_INFINITY;
    const id = leagueEligibleIds[Math.min(slot, leagueEligibleIds.length) - 1];
    return tIdToPts.get(id) ?? Number.POSITIVE_INFINITY;
  };
  const lastUclPts  = boundaryPoints(eu.uclLeagueSlots);
  const lastUelPts  = boundaryPoints(eu.uclLeagueSlots + eu.uelLeagueSlots);
  const lastUeclPts = boundaryPoints(eu.uclLeagueSlots + eu.uelLeagueSlots + eu.ueclLeagueSlots);

  const pos1Pts  = table[0]?.points ?? 0;
  const pos17Pts = table[16]?.points ?? 0;

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
    // Trophy pre-qualified teams (e.g. UEL winner already in next-season
    // UCL) don't NEED a league EU spot — but they still play for cushion
    // pride / TV money / etc. We give them a small stake floor but never
    // dead-rubber-clamp them.
    const trophyPreQualified = trophyPreQualifiedIds.has(t.teamId);

    // §stakes — a stake is "live" iff abs(gap-to-boundary) ≤ maxBridge.
    // For a team ABOVE a boundary the gap is their cushion to the team
    // immediately below; for a team BELOW it the gap is what they'd need
    // to close. We compute against the DYNAMIC boundaries from above,
    // which account for trophy pre-qualifiers cascading the league spots.
    //
    // Boundaries considered:
    //   • title         — gap to/from #1
    //   • UCL cutoff    — last UCL place (default top-5 in 25/26)
    //   • UEL cutoff    — last UEL place (default position 6, unless PL
    //                     cup winners have absorbed one)
    //   • UECL cutoff   — last Conference League place (default position 7)
    //   • relegation    — last safe place (17th)
    const tPts = t.points;
    const cushion = (boundaryPts: number) =>
      tPts >= boundaryPts ? tPts - boundaryPts : boundaryPts - tPts;
    // Title — only "live" if leader's gap-to-#2 is bridgeable (and we're
    // not so far back we couldn't catch even with max wins).
    const titleGap = position === 1
      ? tPts - (table[1]?.points ?? 0)
      : pos1Pts - tPts;
    const uclGap  = cushion(lastUclPts);
    const uelGap  = cushion(lastUelPts);
    const ueclGap = cushion(lastUeclPts);
    const relegGap = position >= 18
      ? (table[16]?.points ?? 0) - tPts
      : tPts - pos17Pts;

    const stakeCandidates: number[] = [];
    if (Math.abs(titleGap) <= maxBridge) stakeCandidates.push(Math.abs(titleGap));
    if (Number.isFinite(uclGap)  && Math.abs(uclGap)  <= maxBridge) stakeCandidates.push(Math.abs(uclGap));
    if (Number.isFinite(uelGap)  && Math.abs(uelGap)  <= maxBridge) stakeCandidates.push(Math.abs(uelGap));
    if (Number.isFinite(ueclGap) && Math.abs(ueclGap) <= maxBridge) stakeCandidates.push(Math.abs(ueclGap));
    if (Math.abs(relegGap) <= maxBridge) stakeCandidates.push(Math.abs(relegGap));

    let motivation: number;
    if (maxBridge === 0 || stakeCandidates.length === 0) {
      motivation = trophyPreQualified ? 0.25 : 0.10;   // nothing to play for
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
