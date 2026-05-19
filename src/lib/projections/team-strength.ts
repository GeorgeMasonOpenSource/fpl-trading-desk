import { sql } from '@/lib/db/client';

/**
 * Estimate per-fixture team expected goals.
 *
 * Determ inistic, simple, and inspectable: combine each team's attack rating
 * with the opponent's defence rating, scaled by a league baseline goals/match
 * (~1.4 per side). Home advantage is an additive log-shift in line with most
 * football models. We persist team_strengths from rolling xG-for / xG-against
 * over the last N matches, with shrinkage toward the FPL strength fields so
 * early-season produces sane numbers.
 */
const LEAGUE_AVG_GOALS_PER_SIDE = 1.40;

export interface TeamFixtureExpectation {
  fixtureId: number;
  teamH: number; teamA: number;
  xgHome: number; xgAway: number;
  cleanSheetProbHome: number; cleanSheetProbAway: number;
  difficultyHome: number; difficultyAway: number;
}

/** Recompute attack/defence ratings from finished fixtures. */
export async function recomputeTeamStrengths() {
  const teams = await sql<Array<{ id: number; strength_attack_home: number; strength_attack_away: number;
                                  strength_def_home: number; strength_def_away: number }>>`
    SELECT id, strength_attack_home, strength_attack_away, strength_def_home, strength_def_away
    FROM teams
  `;
  for (const t of teams) {
    // Rolling actuals (last 8 matches)
    const [m] = await sql<Array<{ for_avg: number; against_avg: number; n: number }>>`
      WITH last_n AS (
        SELECT
          CASE WHEN team_h = ${t.id} THEN team_h_score ELSE team_a_score END AS gf,
          CASE WHEN team_h = ${t.id} THEN team_a_score ELSE team_h_score END AS ga
        FROM fixtures
        WHERE finished = TRUE
          AND (team_h = ${t.id} OR team_a = ${t.id})
        ORDER BY kickoff_time DESC NULLS LAST
        LIMIT 8
      )
      SELECT
        COALESCE(AVG(gf), 1.4) AS for_avg,
        COALESCE(AVG(ga), 1.4) AS against_avg,
        COUNT(*)::int AS n
      FROM last_n
    `;

    // Shrink toward FPL strength (1000 = neutral). The mapping is intentionally
    // gentle: a top side ends up ~1.4-1.7x attack rating, weakest ~0.6-0.8x.
    const fplAttack  = ((t.strength_attack_home + t.strength_attack_away) / 2 - 1000) / 250;
    const fplDefence = ((t.strength_def_home + t.strength_def_away) / 2 - 1000) / 250;
    const priorAttack  = 1 + 0.25 * fplAttack;     // ~0.6..1.4
    const priorDefence = 1 + 0.25 * fplDefence;    // ~0.6..1.4 (higher = better defence)

    const actualAttack  = (m?.for_avg ?? 1.4) / LEAGUE_AVG_GOALS_PER_SIDE;
    const actualDefence = LEAGUE_AVG_GOALS_PER_SIDE / Math.max(0.3, (m?.against_avg ?? 1.4));

    const n = m?.n ?? 0;
    const attack  = (priorAttack  * 6 + actualAttack  * n) / (6 + n);
    const defence = (priorDefence * 6 + actualDefence * n) / (6 + n);

    await sql`
      INSERT INTO team_strengths (team_id, attack_rating, defence_rating, home_advantage, pace, computed_at)
      VALUES (${t.id}, ${attack}, ${defence}, 0.15, 1.0, now())
      ON CONFLICT (team_id) DO UPDATE SET
        attack_rating  = EXCLUDED.attack_rating,
        defence_rating = EXCLUDED.defence_rating,
        computed_at    = now()
    `;
  }
}

export async function fixtureExpectations(fixtureId: number): Promise<TeamFixtureExpectation | null> {
  const [row] = await sql<Array<{
    fixture_id: number; team_h: number; team_a: number;
    th_attack: number; th_def: number; ta_attack: number; ta_def: number;
    th_home_adv: number;
    difficulty_home: number; difficulty_away: number;
  }>>`
    SELECT f.id AS fixture_id, f.team_h, f.team_a,
           sh.attack_rating  AS th_attack, sh.defence_rating AS th_def,
           sa.attack_rating  AS ta_attack, sa.defence_rating AS ta_def,
           sh.home_advantage AS th_home_adv,
           COALESCE(f.team_h_difficulty, 3) AS difficulty_home,
           COALESCE(f.team_a_difficulty, 3) AS difficulty_away
    FROM fixtures f
    LEFT JOIN team_strengths sh ON sh.team_id = f.team_h
    LEFT JOIN team_strengths sa ON sa.team_id = f.team_a
    WHERE f.id = ${fixtureId}
  `;
  if (!row) return null;

  // Symmetric multiplicative model.
  // home xG  = league_avg * home_attack / away_defence * (1 + home_adv)
  // away xG  = league_avg * away_attack / home_defence
  const xgHome = LEAGUE_AVG_GOALS_PER_SIDE * (row.th_attack ?? 1) / Math.max(0.4, row.ta_def ?? 1) * (1 + (row.th_home_adv ?? 0.15));
  const xgAway = LEAGUE_AVG_GOALS_PER_SIDE * (row.ta_attack ?? 1) / Math.max(0.4, row.th_def ?? 1);

  return {
    fixtureId: row.fixture_id,
    teamH: row.team_h, teamA: row.team_a,
    xgHome, xgAway,
    cleanSheetProbHome: Math.exp(-xgAway),
    cleanSheetProbAway: Math.exp(-xgHome),
    difficultyHome: row.difficulty_home,
    difficultyAway: row.difficulty_away
  };
}
