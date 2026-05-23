import { sql } from '@/lib/db/client';

/**
 * "Why" data for transfer rows — used so the user can see WHY a player was
 * suggested without taking the model on faith. Sources only deterministic
 * data we already have in the DB.
 *
 *   - recent: aggregates from player_gameweek_history over the last 5
 *     finished fixtures for that player (NOT the last 5 GWs in the season
 *     — a player who's been injured or rotated may not have appeared in
 *     all of them, and we want the last 5 *meaningful* observations).
 *   - upcoming: next 3 unfinished fixtures with opponent + home/away + FDR
 *     (FPL difficulty rating).
 *   - roles: penalty / set-piece order from bootstrap-static (1 = primary).
 *   - season: full-season totals for context.
 */
export interface RecentMatch {
  gw: number;
  opp: string;           // 3-letter team short name of opponent
  home: boolean;
  started: boolean;
  minutes: number;
  goals: number;
  assists: number;
  bonus: number;
  fplPoints: number;
  xg: number;
  xa: number;
}

export interface PlayerInsight {
  playerId: number;
  position: 'GKP'|'DEF'|'MID'|'FWD';
  matches: RecentMatch[];   // per-match rows, last 5 played, most-recent first
  recent: {
    apps: number;
    starts: number;
    minutes: number;
    goals: number;
    assists: number;
    bonus: number;
    fplPoints: number;
    xg: number;
    xa: number;
  };
  upcoming: Array<{
    gw: number;
    opp: string;
    home: boolean;
    fdr: number;
  }>;
  roles: {
    penaltyOrder: number | null;
    cornersOrder: number | null;
    freekicksOrder: number | null;
  };
  season: {
    minutes: number;
    starts: number;
    goals: number;
    assists: number;
    xg: number;          // raw season_xg (includes pens — kept for back-compat)
    xa: number;
    bonus: number;
    defcon: number;
    defconPer90: number;
  };
  /** Shot-situation aggregates from Understat. null if the player isn't in player_shot_aggregates. */
  shots: {
    openPlayShots: number;
    openPlayXg: number;
    setPieceShots: number;
    setPieceXg: number;
    penaltyShots: number;
    penaltyXg: number;
    directFkShots: number;
    directFkXg: number;
    goalsOpenPlay: number;
    goalsSetPiece: number;
    goalsPenalty: number;
    goalsDirectFk: number;
    /** Per-shot xG (open-play only) — proxy for shot quality. */
    xgPerOpenPlayShot: number;
    /** Non-penalty xG — npxG. The "how dangerous in normal play" number. */
    npxg: number;
    /** Non-penalty goals. */
    npGoals: number;
    /** npGoals - npxG. Positive = over-finishing, negative = unlucky. */
    npFinishingDelta: number;
  } | null;
  /** Per-player Bayesian priors (output of recomputePlayerPriors). null if no entry. */
  priors: {
    goalMult: number;
    assistMult: number;
    bonusMult: number;
    sample90s: number;
    confidence: number;
  } | null;
  /** Per-position defence stats for THIS PLAYER'S NEXT OPPONENT. */
  oppDefence: {
    oppShort: string;
    home: boolean;
    /** xG conceded to attackers of this player's position per match. */
    xgConcededPerMatch: number;
    /** Multiplier vs league average. >1.0 = leaky, <1.0 = strong. */
    defenceMultiplier: number;
    matches: number;
  } | null;
}

/**
 * Batch-fetch insights for many players in one round-trip. We pull every row
 * we need and aggregate in JS — Postgres window functions over JSON_AGG with
 * LIMIT 3 / LIMIT 5 are clunkier than just SELECTing the rows.
 */
export async function getTransferInsights(
  playerIds: number[],
  startGameweek: number
): Promise<Map<number, PlayerInsight>> {
  if (playerIds.length === 0) return new Map();

  // Last 5 *played* fixtures per player. Use a window function so we only
  // return the 5 most-recent finished fixture rows per player, joined to teams
  // for the opponent's short name so the UI can render "vs MUN (H)" style.
  const recentRows = await sql<Array<{
    player_id: number; gameweek_id: number;
    minutes: number; starts: number;
    goals_scored: number; assists: number;
    bonus: number; total_points: number;
    expected_goals: number; expected_assists: number;
    opponent_team: number; was_home: boolean;
    opp_short: string;
  }>>`
    SELECT player_id, gameweek_id, minutes, starts,
           goals_scored, assists, bonus, total_points,
           expected_goals, expected_assists,
           opponent_team, was_home, opp_short
    FROM (
      SELECT pgh.*,
             t.short_name AS opp_short,
             ROW_NUMBER() OVER (
               PARTITION BY pgh.player_id ORDER BY pgh.gameweek_id DESC
             ) AS rn
      FROM player_gameweek_history pgh
      JOIN fixtures f ON f.id = pgh.fixture_id
      LEFT JOIN teams t ON t.id = pgh.opponent_team
      WHERE f.finished = TRUE
        AND pgh.player_id IN ${sql(playerIds as any)}
    ) sub
    WHERE rn <= 5
    ORDER BY player_id, gameweek_id DESC
  `;

  // Upcoming fixtures — next 3 per player. Pull by team_id (a player's
  // fixtures = his team's fixtures).
  const playerTeams = await sql<Array<{ id: number; team_id: number }>>`
    SELECT id, team_id FROM players WHERE id IN ${sql(playerIds as any)}
  `;
  const teamIds = Array.from(new Set(playerTeams.map(p => p.team_id)));
  const teamFixtures = teamIds.length === 0 ? [] : await sql<Array<{
    gameweek_id: number; team_h: number; team_a: number;
    team_h_difficulty: number; team_a_difficulty: number;
    home_short: string; away_short: string;
  }>>`
    SELECT f.gameweek_id, f.team_h, f.team_a,
           f.team_h_difficulty, f.team_a_difficulty,
           th.short_name AS home_short, ta.short_name AS away_short
    FROM fixtures f
    JOIN teams th ON th.id = f.team_h
    JOIN teams ta ON ta.id = f.team_a
    WHERE f.finished = FALSE
      AND f.gameweek_id >= ${startGameweek}
      AND (f.team_h IN ${sql(teamIds as any)} OR f.team_a IN ${sql(teamIds as any)})
    ORDER BY f.gameweek_id
  `;

  // Roles + season totals from players.
  const meta = await sql<Array<{
    id: number; team_id: number; position: 'GKP'|'DEF'|'MID'|'FWD';
    penalties_order: number | null;
    corners_and_indirect_freekicks_order: number | null;
    direct_freekicks_order: number | null;
    season_minutes: number; season_starts: number;
    season_goals: number; season_assists: number;
    season_xg: number; season_xa: number; season_bonus: number;
    season_defcon: number; season_defcon_per_90: number;
  }>>`
    SELECT id, team_id, position,
           penalties_order,
           corners_and_indirect_freekicks_order,
           direct_freekicks_order,
           season_minutes, season_starts,
           season_goals, season_assists,
           season_xg, season_xa, season_bonus,
           COALESCE(season_defcon, 0)        AS season_defcon,
           COALESCE(season_defcon_per_90, 0) AS season_defcon_per_90
    FROM players WHERE id IN ${sql(playerIds as any)}
  `;
  const metaById = new Map(meta.map(m => [m.id, m]));

  // Shot aggregates (Understat) — situation-decomposed xG. Players without
  // an entry (no Understat data) get null shots.
  const shotRows = await sql<Array<{
    player_id: number;
    shots_open_play: number; shots_set_piece: number; shots_penalty: number; shots_direct_fk: number;
    xg_open_play: number; xg_set_piece: number; xg_penalty: number; xg_direct_fk: number;
    goals_open_play: number; goals_set_piece: number; goals_penalty: number; goals_direct_fk: number;
  }>>`
    SELECT player_id,
           shots_open_play, shots_set_piece, shots_penalty, shots_direct_fk,
           xg_open_play, xg_set_piece, xg_penalty, xg_direct_fk,
           goals_open_play, goals_set_piece, goals_penalty, goals_direct_fk
      FROM player_shot_aggregates
     WHERE player_id IN ${sql(playerIds as any)}
  `;
  const shotsById = new Map(shotRows.map(s => [s.player_id, s]));

  // Player priors (Bayesian conversion / assist / bonus multipliers).
  const priorRows = await sql<Array<{
    player_id: number;
    goal_conversion_mult: number;
    assist_conversion_mult: number;
    bonus_per_90_mult: number;
    sample_90s: number;
    confidence: number;
  }>>`
    SELECT player_id, goal_conversion_mult, assist_conversion_mult,
           bonus_per_90_mult, sample_90s, confidence
      FROM player_priors
     WHERE player_id IN ${sql(playerIds as any)}
  `;
  const priorsById = new Map(priorRows.map(r => [r.player_id, r]));

  // Opponent defence vs this player's position, for THIS player's next fixture.
  // Indexed by (team_id, attacker_position) — we resolve the next-opponent's
  // team_id below and look up the matching row.
  const tdbpRows = await sql<Array<{
    team_id: number;
    attacker_position: 'GKP'|'DEF'|'MID'|'FWD';
    xg_per_match: number;
    multiplier: number;
    matches: number;
  }>>`
    SELECT team_id, attacker_position, xg_per_match, multiplier, matches
      FROM team_defence_by_position
  `;
  const tdbpByKey = new Map<string, { xg_per_match: number; multiplier: number; matches: number }>();
  for (const r of tdbpRows) {
    tdbpByKey.set(`${r.team_id}|${r.attacker_position}`, {
      xg_per_match: Number(r.xg_per_match),
      multiplier:   Number(r.multiplier),
      matches:      Number(r.matches)
    });
  }

  // Assemble per-player insight.
  const recentByPlayer = new Map<number, typeof recentRows>();
  for (const r of recentRows) {
    if (!recentByPlayer.has(r.player_id)) recentByPlayer.set(r.player_id, [] as any);
    recentByPlayer.get(r.player_id)!.push(r);
  }

  const out = new Map<number, PlayerInsight>();
  for (const p of playerTeams) {
    const m = metaById.get(p.id);
    const recent = recentByPlayer.get(p.id) ?? [];
    const teamFx = teamFixtures
      .filter(f => f.team_h === p.team_id || f.team_a === p.team_id)
      .slice(0, 3)
      .map(f => {
        const home = f.team_h === p.team_id;
        return {
          gw: f.gameweek_id,
          opp: home ? f.away_short : f.home_short,
          home,
          fdr: home ? f.team_h_difficulty : f.team_a_difficulty
        };
      });

    const sh = shotsById.get(p.id);
    const shots = sh ? {
      openPlayShots:   Number(sh.shots_open_play)   || 0,
      openPlayXg:      Number(sh.xg_open_play)      || 0,
      setPieceShots:   Number(sh.shots_set_piece)   || 0,
      setPieceXg:      Number(sh.xg_set_piece)      || 0,
      penaltyShots:    Number(sh.shots_penalty)     || 0,
      penaltyXg:       Number(sh.xg_penalty)        || 0,
      directFkShots:   Number(sh.shots_direct_fk)   || 0,
      directFkXg:      Number(sh.xg_direct_fk)      || 0,
      goalsOpenPlay:   Number(sh.goals_open_play)   || 0,
      goalsSetPiece:   Number(sh.goals_set_piece)   || 0,
      goalsPenalty:    Number(sh.goals_penalty)     || 0,
      goalsDirectFk:   Number(sh.goals_direct_fk)   || 0,
      xgPerOpenPlayShot: 0, npxg: 0, npGoals: 0, npFinishingDelta: 0
    } : null;
    if (shots) {
      shots.xgPerOpenPlayShot = shots.openPlayShots > 0
        ? shots.openPlayXg / shots.openPlayShots
        : 0;
      shots.npxg     = shots.openPlayXg + shots.setPieceXg + shots.directFkXg;
      shots.npGoals  = shots.goalsOpenPlay + shots.goalsSetPiece + shots.goalsDirectFk;
      shots.npFinishingDelta = shots.npGoals - shots.npxg;
    }

    const pr = priorsById.get(p.id);
    const priors = pr ? {
      goalMult:   Number(pr.goal_conversion_mult)   || 1,
      assistMult: Number(pr.assist_conversion_mult) || 1,
      bonusMult:  Number(pr.bonus_per_90_mult)      || 1,
      sample90s:  Number(pr.sample_90s)             || 0,
      confidence: Number(pr.confidence)             || 0
    } : null;

    // Next-opponent defence vs this player's position.
    const firstFx = teamFx[0];
    const position = (m?.position ?? 'MID') as 'GKP'|'DEF'|'MID'|'FWD';
    let oppDefence: PlayerInsight['oppDefence'] = null;
    if (firstFx) {
      // We need the opponent's team_id. teamFx already has opp short — find the
      // fixture row to recover team ids. (Cheap: just walk teamFixtures.)
      const fxRow = teamFixtures.find(f =>
        f.gameweek_id === firstFx.gw &&
        (f.team_h === p.team_id || f.team_a === p.team_id)
      );
      if (fxRow) {
        const oppTeamId = fxRow.team_h === p.team_id ? fxRow.team_a : fxRow.team_h;
        const tdbp = tdbpByKey.get(`${oppTeamId}|${position}`);
        if (tdbp) {
          oppDefence = {
            oppShort: firstFx.opp,
            home: firstFx.home,
            xgConcededPerMatch: tdbp.xg_per_match,
            defenceMultiplier:  tdbp.multiplier,
            matches:            tdbp.matches
          };
        }
      }
    }

    out.set(p.id, {
      playerId: p.id,
      position,
      matches: recent.map(r => ({
        gw: r.gameweek_id,
        opp: (r as any).opp_short ?? '???',
        home: !!(r as any).was_home,
        started: Number(r.starts) > 0,
        minutes: Number(r.minutes),
        goals: Number(r.goals_scored),
        assists: Number(r.assists),
        bonus: Number(r.bonus),
        fplPoints: Number(r.total_points),
        xg: Number(r.expected_goals),
        xa: Number(r.expected_assists)
      })),
      recent: {
        apps: recent.filter(r => Number(r.minutes) > 0).length,
        starts: recent.reduce((s, r) => s + (Number(r.starts) || 0), 0),
        minutes: recent.reduce((s, r) => s + Number(r.minutes), 0),
        goals: recent.reduce((s, r) => s + Number(r.goals_scored), 0),
        assists: recent.reduce((s, r) => s + Number(r.assists), 0),
        bonus: recent.reduce((s, r) => s + Number(r.bonus), 0),
        fplPoints: recent.reduce((s, r) => s + Number(r.total_points), 0),
        xg: recent.reduce((s, r) => s + Number(r.expected_goals), 0),
        xa: recent.reduce((s, r) => s + Number(r.expected_assists), 0)
      },
      upcoming: teamFx,
      roles: {
        penaltyOrder: m?.penalties_order ?? null,
        cornersOrder: m?.corners_and_indirect_freekicks_order ?? null,
        freekicksOrder: m?.direct_freekicks_order ?? null
      },
      season: {
        minutes: Number(m?.season_minutes) || 0,
        starts: Number(m?.season_starts) || 0,
        goals: Number(m?.season_goals) || 0,
        assists: Number(m?.season_assists) || 0,
        xg: Number(m?.season_xg) || 0,
        xa: Number(m?.season_xa) || 0,
        bonus: Number(m?.season_bonus) || 0,
        defcon: Number(m?.season_defcon) || 0,
        defconPer90: Number(m?.season_defcon_per_90) || 0
      },
      shots,
      priors,
      oppDefence
    });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * EV decomposition + per-fixture deltas (for the Transfer Planner's "why")
 *
 * `getTransferEvBreakdown` returns, for every player in `playerIds`:
 *   - components: summed xpts_* components over the next `horizonGws` fixtures
 *   - perFixture: one row per upcoming fixture (next ≤ horizonGws) with the
 *     fixture's xpts_total, opponent short, home/away, and gameweek_id
 *
 * Two reads:
 *   (1) projections joined to fixtures filtered by gameweek_id window
 *   (2) teams lookup so we can resolve the opponent's short_name
 *
 * The caller then computes IN - OUT component deltas and renders the bar.
 * Keeping the math in the UI layer keeps the SQL simple and reusable for the
 * compare-to overlay (§3d), which feeds in arbitrary player_id pairs.
 * -------------------------------------------------------------------------*/

export interface EvComponents {
  appearance: number;
  goals: number;
  assists: number;
  cleanSheet: number;
  bonus: number;
  saves: number;
  penSave: number;
  cards: number;       // negative (a penalty)
  concede: number;     // negative (a penalty)
  owngoal: number;     // negative
  defcon: number;
  total: number;
}

export interface FixturePoint {
  gameweekId: number;
  fixtureId: number;
  opp: string;
  home: boolean;
  xpts: number;
}

export interface PlayerEvBreakdown {
  playerId: number;
  components: EvComponents;
  perFixture: FixturePoint[];
}

const ZERO_COMPONENTS: EvComponents = {
  appearance: 0, goals: 0, assists: 0, cleanSheet: 0, bonus: 0,
  saves: 0, penSave: 0, cards: 0, concede: 0, owngoal: 0, defcon: 0, total: 0
};

export async function getTransferEvBreakdown(
  playerIds: number[],
  startGameweek: number,
  horizonGws: number
): Promise<Map<number, PlayerEvBreakdown>> {
  if (playerIds.length === 0 || horizonGws <= 0) return new Map();
  const endGw = startGameweek + horizonGws - 1;

  // Pull every projection row in the window for every requested player. The
  // join to fixtures + teams lets us resolve "opponent short" without a second
  // round-trip. Note: a player's team_id can change mid-season (loan, transfer
  // window) — we resolve `was_home` by comparing fixture.team_h to the player's
  // CURRENT team_id, which is the same logic the rest of the app uses.
  const rows = await sql<Array<{
    player_id: number; fixture_id: number; gameweek_id: number;
    team_id: number; team_h: number; team_a: number;
    home_short: string; away_short: string;
    xpts_total: number;
    xpts_appearance: number; xpts_goals: number; xpts_assists: number;
    xpts_clean_sheet: number; xpts_bonus: number; xpts_saves: number;
    xpts_pen_save: number; xpts_cards: number; xpts_concede: number;
    xpts_owngoal: number; xpts_defcon: number;
  }>>`
    SELECT pr.player_id, pr.fixture_id, pr.gameweek_id,
           p.team_id,
           f.team_h, f.team_a,
           th.short_name AS home_short,
           ta.short_name AS away_short,
           pr.xpts_total,
           pr.xpts_appearance, pr.xpts_goals, pr.xpts_assists,
           pr.xpts_clean_sheet, pr.xpts_bonus, pr.xpts_saves,
           pr.xpts_pen_save, pr.xpts_cards, pr.xpts_concede,
           pr.xpts_owngoal, COALESCE(pr.xpts_defcon, 0) AS xpts_defcon
      FROM projections pr
      JOIN players p ON p.id = pr.player_id
      JOIN fixtures f ON f.id = pr.fixture_id
      JOIN teams th ON th.id = f.team_h
      JOIN teams ta ON ta.id = f.team_a
     WHERE pr.player_id IN ${sql(playerIds as any)}
       AND pr.gameweek_id BETWEEN ${startGameweek} AND ${endGw}
     ORDER BY pr.player_id, pr.gameweek_id
  `;

  const out = new Map<number, PlayerEvBreakdown>();
  // Seed every requested player so the caller always gets a value, even if
  // the player has no projections in the window (e.g. zero upcoming fixtures).
  for (const id of playerIds) {
    out.set(id, { playerId: id, components: { ...ZERO_COMPONENTS }, perFixture: [] });
  }
  for (const r of rows) {
    const entry = out.get(r.player_id)!;
    const isHome = r.team_h === r.team_id;
    entry.perFixture.push({
      gameweekId: r.gameweek_id,
      fixtureId: r.fixture_id,
      opp: isHome ? r.away_short : r.home_short,
      home: isHome,
      xpts: Number(r.xpts_total) || 0
    });
    // A double-gameweek shows up as two rows for the same gameweek_id; we sum
    // both into the components so the totals match xpts in the planner.
    entry.components.appearance += Number(r.xpts_appearance) || 0;
    entry.components.goals      += Number(r.xpts_goals) || 0;
    entry.components.assists    += Number(r.xpts_assists) || 0;
    entry.components.cleanSheet += Number(r.xpts_clean_sheet) || 0;
    entry.components.bonus      += Number(r.xpts_bonus) || 0;
    entry.components.saves      += Number(r.xpts_saves) || 0;
    entry.components.penSave    += Number(r.xpts_pen_save) || 0;
    entry.components.cards      += Number(r.xpts_cards) || 0;
    entry.components.concede    += Number(r.xpts_concede) || 0;
    entry.components.owngoal    += Number(r.xpts_owngoal) || 0;
    entry.components.defcon     += Number(r.xpts_defcon) || 0;
    entry.components.total      += Number(r.xpts_total) || 0;
  }
  return out;
}

/**
 * Compute the per-component delta of a swap (IN - OUT). Negative deltas mean
 * the outgoing player was actually stronger on that component — useful for
 * showing "we're trading 0.3 clean-sheet points to gain 0.9 goal-threat".
 */
export function diffComponents(
  inc: EvComponents,
  out: EvComponents
): EvComponents {
  return {
    appearance: inc.appearance - out.appearance,
    goals:      inc.goals      - out.goals,
    assists:    inc.assists    - out.assists,
    cleanSheet: inc.cleanSheet - out.cleanSheet,
    bonus:      inc.bonus      - out.bonus,
    saves:      inc.saves      - out.saves,
    penSave:    inc.penSave    - out.penSave,
    cards:      inc.cards      - out.cards,
    concede:    inc.concede    - out.concede,
    owngoal:    inc.owngoal    - out.owngoal,
    defcon:     inc.defcon     - out.defcon,
    total:      inc.total      - out.total
  };
}

/**
 * Pair the IN player's per-fixture xPts with the OUT player's per-fixture
 * xPts, matched by gameweek_id. Double-gameweeks are summed before pairing.
 * Returns the union of both players' upcoming GWs so the user sees blanks
 * on either side (e.g. a player going to a team with a blank GW shows 0).
 */
export interface PerGwDelta {
  gameweekId: number;
  inXpts: number;
  outXpts: number;
  inOpp: string | null;
  outOpp: string | null;
  inHome: boolean | null;
  outHome: boolean | null;
  delta: number;
}

export function pairPerFixture(
  inFixtures: FixturePoint[],
  outFixtures: FixturePoint[]
): PerGwDelta[] {
  const sumByGw = (fxs: FixturePoint[]) => {
    const m = new Map<number, { xpts: number; opp: string; home: boolean }>();
    for (const f of fxs) {
      const prev = m.get(f.gameweekId);
      if (!prev) {
        m.set(f.gameweekId, { xpts: f.xpts, opp: f.opp, home: f.home });
      } else {
        // Double GW: sum xpts, label both opponents.
        m.set(f.gameweekId, {
          xpts: prev.xpts + f.xpts,
          opp: `${prev.opp}+${f.opp}`,
          home: prev.home
        });
      }
    }
    return m;
  };
  const inMap = sumByGw(inFixtures);
  const outMap = sumByGw(outFixtures);
  const gws = Array.from(new Set([...inMap.keys(), ...outMap.keys()])).sort((a, b) => a - b);
  return gws.map(gw => {
    const i = inMap.get(gw);
    const o = outMap.get(gw);
    return {
      gameweekId: gw,
      inXpts: i?.xpts ?? 0,
      outXpts: o?.xpts ?? 0,
      inOpp: i?.opp ?? null,
      outOpp: o?.opp ?? null,
      inHome: i?.home ?? null,
      outHome: o?.home ?? null,
      delta: (i?.xpts ?? 0) - (o?.xpts ?? 0)
    };
  });
}
