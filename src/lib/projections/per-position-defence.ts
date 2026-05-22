import { sql } from '@/lib/db/client';

/**
 * Per-(opponent-team, attacker-position) defensive ratings.
 *
 * One number per team — `defensive_solidity` — flattens the truth that
 * teams have different defensive profiles against each position. Leeds
 * are terrible at defending forwards specifically (relegation-tier high
 * line, slow CBs) but only mid-bad at midfield long-shots. Our engine
 * was multiplying every position's expected goals by the same flat
 * defensive number — under-rating attackers who face FWD-leaky teams.
 *
 * This recompute fills team_defence_by_position with a per-position
 * multiplier derived from observed xG-conceded. The engine reads
 * `opponent.defence_vs_<player_position>` instead of the flat number.
 *
 * Where the data comes from:
 *   - player_shot_history (Understat ingest) has every shot the season
 *     has produced, including the shooter's player_id.
 *   - Join to players to get the shooter's position.
 *   - GROUP BY (opponent_team_id, position).
 *
 * League averages computed once across the same data; multipliers are
 * each team's per-position xG-per-match divided by the league mean for
 * that position.
 *
 * Multipliers are clamped to [0.6, 1.6] to protect against pathological
 * single-team samples (e.g. a brand-new promoted side with 2 games of
 * data against a particular position).
 */
export async function recomputePerPositionDefence(): Promise<void> {
  // Pull shot-conceded counts per (opp_team, shooter_position).
  // shots_conceded comes from `opponent_team_id` in player_shot_history.
  const raw = await sql<Array<{
    opponent_team_id: number;
    position: 'GKP'|'DEF'|'MID'|'FWD';
    total_xg: number;
    shots: number;
    goals: number;
  }>>`
    SELECT psh.opponent_team_id,
           p.position,
           SUM(psh.xg)::float8                              AS total_xg,
           COUNT(*)::int                                     AS shots,
           COUNT(*) FILTER (WHERE psh.result = 'Goal')::int  AS goals
      FROM player_shot_history psh
      JOIN players p ON p.id = psh.player_id
     WHERE psh.opponent_team_id IS NOT NULL
     GROUP BY psh.opponent_team_id, p.position
  `;

  // Pull match counts per (opp_team) — denominator for per-match xG.
  const matchRows = await sql<Array<{ team_id: number; matches: number }>>`
    SELECT opponent_team_id AS team_id,
           COUNT(DISTINCT match_date)::int AS matches
      FROM player_shot_history
     WHERE opponent_team_id IS NOT NULL
     GROUP BY opponent_team_id
  `;
  const matchesByTeam = new Map(matchRows.map(r => [r.team_id, Number(r.matches)]));

  // League average per-match xG conceded per position.
  // Method: for each position, sum xG across all teams, divide by total
  // (team × match) pairs that had at least one shot from that position.
  const positions: Array<'GKP'|'DEF'|'MID'|'FWD'> = ['GKP', 'DEF', 'MID', 'FWD'];
  const leagueAvg: Record<string, number> = {};
  for (const pos of positions) {
    const posRows = raw.filter(r => r.position === pos);
    const totalXg = posRows.reduce((s, r) => s + Number(r.total_xg), 0);
    const totalMatches = posRows.reduce((s, r) => s + (matchesByTeam.get(r.opponent_team_id) ?? 0), 0);
    // Average across teams (each team contributes its season). We divide
    // by N_teams × matches_per_team = total (team, match) pairs.
    leagueAvg[pos] = totalMatches > 0 ? totalXg / totalMatches : 0.5;
  }

  // Build inserts. For positions a team faced 0 shots from (rare, e.g.
  // teams with no GKP shots against), default multiplier=1.0.
  await sql`TRUNCATE team_defence_by_position`;
  for (const r of raw) {
    const matches = Math.max(1, matchesByTeam.get(r.opponent_team_id) ?? 1);
    const xgPerMatch = Number(r.total_xg) / matches;
    const league = leagueAvg[r.position] || 0.5;
    const rawMult = league > 0 ? xgPerMatch / league : 1.0;
    // Clamp [0.6, 1.6]: a team can be 40% better/worse than average vs
    // this position, but anything beyond that is small-sample noise.
    const multiplier = Math.max(0.6, Math.min(1.6, rawMult));
    await sql`
      INSERT INTO team_defence_by_position
        (team_id, attacker_position, total_xg_conceded, shots_conceded,
         goals_conceded, matches, xg_per_match, multiplier)
      VALUES
        (${r.opponent_team_id}, ${r.position},
         ${Number(r.total_xg)}, ${Number(r.shots)},
         ${Number(r.goals)}, ${matches},
         ${xgPerMatch}, ${multiplier})
      ON CONFLICT (team_id, attacker_position) DO UPDATE
        SET total_xg_conceded = EXCLUDED.total_xg_conceded,
            shots_conceded    = EXCLUDED.shots_conceded,
            goals_conceded    = EXCLUDED.goals_conceded,
            matches           = EXCLUDED.matches,
            xg_per_match      = EXCLUDED.xg_per_match,
            multiplier        = EXCLUDED.multiplier,
            updated_at        = now()
    `;
  }
}

/**
 * Helper for the engine: get the position-specific defensive multiplier
 * for an opponent team vs an attacker's position. Falls back to 1.0
 * (= neutral) if the data isn't there yet (e.g. before migration 0011
 * applied or recompute has run).
 */
export async function getDefenceVsPositionMap(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const rows = await sql<Array<{
      team_id: number; attacker_position: string; multiplier: number;
    }>>`
      SELECT team_id, attacker_position, multiplier::float8
        FROM team_defence_by_position
    `;
    for (const r of rows) {
      out.set(`${r.team_id}:${r.attacker_position}`, Number(r.multiplier));
    }
  } catch {/* table may not exist yet */}
  return out;
}
