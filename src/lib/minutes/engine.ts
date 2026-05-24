import { sql } from '@/lib/db/client';
import { clamp01, logistic } from '@/lib/util/math';
import { computeReliability, computeRotationResistance } from './reliability';
import type { ProjectionReason } from '@/lib/db/types';

/**
 * Minutes Engine.
 *
 * For every (player, future fixture) pair, produce a *distribution* over the
 * possible minutes outcomes:
 *
 *   - injury_absence : flagged out, didn't play
 *   - bench_unused   : in squad, didn't come on
 *   - sub            : came on as substitute (1..59 minutes typically)
 *   - sixty_plus     : played 60-89 minutes
 *   - ninety         : played 90+ minutes
 *
 * The expected-points layer must consume the whole distribution, not just
 * expected minutes. A 0.80 chance of 90 + 0.20 chance of 0 is very different
 * from a 1.00 chance of 72.
 *
 * Inputs are deterministic and observable. Nothing here is ML.
 */

export interface MinutesInputs {
  playerId: number;
  fixtureId: number;
  // From player_baselines + recent observation:
  reliability: number;              // 0..1 historical availability + congestion resilience
  rotationResistance: number;       // 0..1 — how little congestion penalty applies
  currentSeasonStartRate: number;   // 0..1 from this season's lineup observations
  currentSeasonNinetyRate: number;  // 0..1
  currentSeasonAppearanceRate: number;
  // Recency-weighted rates over the last few played fixtures (decay 0.6 per
  // step). When recentStartSample is high (≥ ~2.3, i.e. 5 played fixtures in
  // the window), recent rates dominate season rates — so a player who's been
  // benched in the last 3 weeks (Havertz over Gyökeres, Wilson hit-and-miss,
  // Cherki dropped) sees their start prob collapse in real time instead of
  // riding their season-long start rate.
  recentStartRate?: number;
  recentNinetyRate?: number;
  recentAppearanceRate?: number;
  recentStartSample?: number;       // 0..~2.31 — effective sample size after decay
  // §observed-mins-floor — the player's actual mean minutes-per-appearance
  // over the last 5 played fixtures + the season-long average. These let us
  // floor expected_minutes at what the player has ACTUALLY played, not at
  // a hand-wavy "75 if not 90" heuristic. A player who logs 88 mins/app
  // every game shouldn't be predicted at 75 just because our structural
  // formula has rounding losses.
  recentAvgMinsPerApp?: number;     // mean of m.minutes where m.minutes > 0, over last 5
  seasonAvgMinsPerApp?: number;     // season total minutes / appearances
  fplStatus: 'a' | 'd' | 'i' | 'n' | 's' | 'u';
  chanceOfPlayingNext: number | null; // 0..100 from FPL
  // §news-gate — FPL's `news` field. Often updates BEFORE status flips
  // (press conferences, late-breaking injuries, "joined Flamengo
  // permanently"). The minutes engine parses this for hard-out signals
  // and forces injuryAbsenceProb to 1.0 when found, closing the gap
  // where status='a' but news already says out.
  fplNews?: string | null;
  // §yc-suspension — true when the player crossed a 5/10/15 cumulative
  // yellow-card threshold in the last finished GW. Equivalent to a 1-match
  // FPL suspension, but we detect it ourselves rather than waiting for FPL
  // to flip status='s'.
  ycSuspendedNext?: boolean;
  // Context for this specific fixture:
  isPostEuropeanFixture: boolean;
  isPreEuropeanFixture: boolean;
  daysRestBefore: number | null;
  daysRestAfter: number | null;
  fixtureImportance: number;        // 0..2 — late season title race etc.
  // §team-motivation — how much the team has to play for. Mid-season this
  // is ~1.0; final 3 GWs of a relegated/safe team it collapses to 0.5;
  // top-4 chase or relegation fight pushes it to 1.0+. Affects mins by
  // ±10% — relegated teams rest starters; teams fighting for stakes don't.
  teamMotivation?: number;          // 0..1 (sweet spot ~0.7 = no stakes left)
  // §depth — how many of the team's other regular starters are currently
  // OUT (status='i' or 'u' or doubt). When teammates are injured, the
  // remaining starters play more (no fresh legs on bench to rotate in).
  teamInjuredStarters?: number;     // 0..6 typically
  // Depth-chart signal: number of stronger alternatives currently available
  // (computed from current season role evidence).
  competitorPressure: number;       // 0..1
  // Injury return path: 1 = first match back, 2 = second, ... null = not returning
  returnFromInjuryMatch: number | null;
  // Manual overrides (already coalesced):
  manualMinutesCap?: number;        // hard cap minutes (e.g. "60 max on return")
  manualExpectedAbsence?: boolean;
}

export interface MinutesDistribution {
  startProb: number;
  sixtyPlusProb: number;
  ninetyProb: number;
  subProb: number;
  benchUnusedProb: number;
  injuryAbsenceProb: number;
  expectedMinutes: number;
  earlySubRisk: number;
  rotationRisk: number;
  rotationResistance: number;
  reliability: number;
  confidence: number;
  reasons: ProjectionReason[];
}

export function projectMinutes(input: MinutesInputs): MinutesDistribution {
  const reasons: ProjectionReason[] = [];

  // 1. Injury / availability gate ---------------------------------------------
  // The gate is a layered priority:
  //   (1) news-based hard-out detection (FPL updates `news` before `status`)
  //   (2) FPL status flag (a/d/i/n/s/u)
  //   (3) chance_of_playing_next_round applies on top whenever it's set,
  //       not just for status='d' — FPL frequently flags chance=75 without
  //       flipping status to 'd'.
  let injuryAbsenceProb = 0;
  if (input.manualExpectedAbsence) {
    injuryAbsenceProb = 0.99;
    reasons.push({ kind: 'manual_absence_override', weight: 0.99, detail: 'manual override: expected absence' });
  } else if (input.ycSuspendedNext) {
    // YC threshold crossed in the most recent finished GW → banned next GW.
    // Treated as deterministically out. FPL frequently lags on this flag —
    // we detect it from cumulative YC counts directly.
    injuryAbsenceProb = 0.99;
    reasons.push({ kind: 'yc_suspension', weight: 0.99, detail: 'yellow-card threshold reached last GW — suspended next match' });
  } else {
    // §news-gate — late-breaking unavailability that FPL hasn't yet
    // reflected in `status`. Patterns observed in bootstrap:
    //   "Suspended for the match against..."
    //   "Suspended until 29 Aug"
    //   "Not available for the match against ... on dd/m."
    //   "Made unavailable for selection on dd/m."
    //   "has joined <club> permanently."
    // Each is a hard-out signal: force absence to ~1.0 regardless of
    // the stale status flag.
    const newsLc = (input.fplNews ?? '').toLowerCase();
    const hardOut =
      /\bsuspended\b/.test(newsLc) ||
      /not available for the match/.test(newsLc) ||
      /made unavailable for selection/.test(newsLc) ||
      /joined .* permanently/.test(newsLc) ||
      /transferred to/.test(newsLc) ||
      /has left the club/.test(newsLc);
    if (hardOut) {
      injuryAbsenceProb = 0.99;
      reasons.push({ kind: 'news_hard_out', weight: 0.99, detail: `news: ${input.fplNews?.slice(0, 80) ?? ''}` });
    } else {
      switch (input.fplStatus) {
        case 'a': injuryAbsenceProb = 0.02; break;            // available
        case 'd': {                                             // doubtful — use chance of playing
          const chance = input.chanceOfPlayingNext == null ? 50 : input.chanceOfPlayingNext;
          injuryAbsenceProb = clamp01(1 - chance / 100);
          reasons.push({ kind: 'doubt_flag', weight: injuryAbsenceProb, detail: `chance of playing: ${chance}%` });
          break;
        }
        case 'i': injuryAbsenceProb = 0.95; break;            // injured (was 0.92 — too soft)
        case 'n': injuryAbsenceProb = 0.99; break;            // not available for this match (was 0.90 — should be near-100%)
        case 's': injuryAbsenceProb = 0.99; break;            // suspended (was 0.97)
        case 'u': injuryAbsenceProb = 0.99; break;            // transferred / no longer at club (was 0.90 — should be 100%)
      }
    }
    // §chance-of-playing for ANY status — if FPL has set a chance value
    // and we haven't already used it via the 'd' branch, take the MIN
    // (more pessimistic). Closes the gap where a status='a' player has
    // chance=75 due to a yellow flag.
    if (input.fplStatus !== 'd' && !hardOut && input.chanceOfPlayingNext != null && input.chanceOfPlayingNext < 100) {
      const chanceBasedAbsence = clamp01(1 - input.chanceOfPlayingNext / 100);
      if (chanceBasedAbsence > injuryAbsenceProb) {
        injuryAbsenceProb = chanceBasedAbsence;
        reasons.push({
          kind: 'chance_of_playing',
          weight: chanceBasedAbsence,
          detail: `FPL chance ${input.chanceOfPlayingNext}% despite status='${input.fplStatus}'`,
        });
      }
    }
  }

  // 2. Start probability (given available) -----------------------------------
  // First, blend season start rate with the recency-weighted start rate so a
  // player who's been recently dropped collapses fast. recencyWeight ramps
  // from 0 (no recent data) to ~1 (5+ played fixtures in window).
  const recencyWeight = clamp01((input.recentStartSample ?? 0) / 2.0);
  const blendedStartRate =
    recencyWeight * (input.recentStartRate ?? input.currentSeasonStartRate) +
    (1 - recencyWeight) * input.currentSeasonStartRate;
  if (recencyWeight > 0.3 && input.recentStartRate != null &&
      Math.abs(input.recentStartRate - input.currentSeasonStartRate) > 0.20) {
    reasons.push({
      kind: 'recency_shift',
      weight: input.recentStartRate - input.currentSeasonStartRate,
      detail: `recent starts ${(input.recentStartRate*100).toFixed(0)}% vs season ${(input.currentSeasonStartRate*100).toFixed(0)}%`
    });
  }

  // Reliability acts as a stabiliser for thin samples.
  let startGivenAvailable =
    0.70 * blendedStartRate +
    0.30 * input.reliability;

  // Competitor pressure penalises the start prob.
  startGivenAvailable -= 0.25 * input.competitorPressure;
  if (input.competitorPressure > 0.1) {
    reasons.push({ kind: 'competitor_pressure', weight: input.competitorPressure, detail: `${(input.competitorPressure*100).toFixed(0)}% squad pressure` });
  }

  // Rotation penalty for European fixtures — scaled DOWN by rotation resistance.
  // Highly resistant players (a Bruno-type profile or a nailed CB) see a tiny
  // dent; a rotation-prone winger sees a big dent.
  let rotationPenalty = 0;
  if (input.isPostEuropeanFixture) {
    const base = 0.18;
    const scaled = base * (1 - input.rotationResistance);
    rotationPenalty += scaled;
    reasons.push({ kind: 'post_european', weight: scaled, detail: `post-European fixture rotation penalty (resistance ${(input.rotationResistance*100).toFixed(0)}%)` });
  }
  if (input.isPreEuropeanFixture) {
    const base = 0.10;
    const scaled = base * (1 - input.rotationResistance);
    rotationPenalty += scaled;
    reasons.push({ kind: 'pre_european', weight: scaled, detail: `pre-European fixture rotation penalty` });
  }
  if (input.daysRestBefore != null && input.daysRestBefore <= 3) {
    const fatiguePenalty = (4 - input.daysRestBefore) * 0.05 * (1 - input.rotationResistance);
    rotationPenalty += fatiguePenalty;
    reasons.push({ kind: 'fixture_congestion', weight: fatiguePenalty, detail: `${input.daysRestBefore} days rest` });
  }
  // Late season / important fixtures: rotation actually DECREASES.
  if (input.fixtureImportance > 1.2) {
    rotationPenalty -= 0.05;
    reasons.push({ kind: 'fixture_importance', weight: 0.05, detail: 'important match — less rotation' });
  }

  startGivenAvailable -= rotationPenalty;

  // §dead-rubber → startProb (not just expected_minutes). The previous
  // engine applied motivation ONLY to expected_minutes, so a "team with
  // nothing to play for" still saw full startProb → bonus and CS engines
  // downstream over-projected. Mirror the same multiplier on startProb so
  // the rotation reality flows everywhere.
  const motivationForStart = input.teamMotivation ?? 0.7;
  if (motivationForStart < 0.7) {
    const startMult = 1.0 - 0.25 * Math.min(1, (0.7 - motivationForStart) / 0.7);
    startGivenAvailable *= startMult;
  }

  // Returning from injury: cap start prob aggressively in match 1, partial in match 2.
  if (input.returnFromInjuryMatch === 1) {
    startGivenAvailable = Math.min(startGivenAvailable, 0.45);
    reasons.push({ kind: 'return_match_1', weight: 0.4, detail: 'first match back — minutes cap likely' });
  } else if (input.returnFromInjuryMatch === 2) {
    startGivenAvailable = Math.min(startGivenAvailable, 0.70);
    reasons.push({ kind: 'return_match_2', weight: 0.2, detail: 'second match back — partial cap' });
  }

  startGivenAvailable = clamp01(startGivenAvailable);

  const startProb = clamp01(startGivenAvailable * (1 - injuryAbsenceProb));

  // 3. Once starting: distribution over how many minutes ----------------------
  // 90-min rate, conditional on starting — blended with recent observation.
  const blendedNinetyRate =
    recencyWeight * (input.recentNinetyRate ?? input.currentSeasonNinetyRate) +
    (1 - recencyWeight) * input.currentSeasonNinetyRate;
  const ninetyGivenStart = clamp01(
    0.70 * blendedNinetyRate +
    0.30 * input.reliability -
    (input.returnFromInjuryMatch === 1 ? 0.6 : 0) -
    (input.returnFromInjuryMatch === 2 ? 0.3 : 0)
  );
  const sixtyToEightyNineGivenStart = clamp01(1 - ninetyGivenStart - 0.05);
  // tiny residual: "started but went off before 60"
  const startedButEarlyOff = clamp01(1 - ninetyGivenStart - sixtyToEightyNineGivenStart);

  // 4. Sub appearances (given not starting & available) ----------------------
  const blendedAppearanceRate =
    recencyWeight * (input.recentAppearanceRate ?? input.currentSeasonAppearanceRate) +
    (1 - recencyWeight) * input.currentSeasonAppearanceRate;
  const subGivenNotStartingAvail = clamp01(
    0.6 * blendedAppearanceRate -
    0.4 * blendedStartRate
  );

  // 5. Compose distribution ---------------------------------------------------
  const availableNotStarting = (1 - injuryAbsenceProb) - startProb;
  const subProb = clamp01(availableNotStarting * subGivenNotStartingAvail);
  const benchUnusedProb = clamp01(availableNotStarting - subProb);
  const ninetyProb = clamp01(startProb * ninetyGivenStart);
  const sixtyPlusProb = clamp01(startProb * sixtyToEightyNineGivenStart + ninetyProb);
  const earlySubRisk = clamp01(startProb * startedButEarlyOff);

  // 6. Expected minutes -------------------------------------------------------
  // Honour any manual cap (e.g. "manager said 60 max").
  const cap = input.manualMinutesCap ?? 90;

  // §structural — the original heuristic. Decomposes by start/sub bucket
  // and assigns canonical mid-points (90, 75, 35, 20). Theoretically clean
  // but loses minutes whenever ninetyProb < 1 (a 95% 90-min starter
  // gets ~85 mins instead of ~90).
  const structuralExpectedMinutes =
    ninetyProb * Math.min(90, cap) +
    (startProb - ninetyProb) * Math.min(75, cap) +    // 60-89 starters average ~75
    earlySubRisk * Math.min(35, cap) +
    subProb * Math.min(20, cap) +
    benchUnusedProb * 0 +
    injuryAbsenceProb * 0;

  // §observed — what the player has ACTUALLY logged per appearance over
  // recent and season. If Bowen averages 87 mins/app, that's the right
  // anchor — not "75 because his ninetyRate is 0.92". We use a 70/30
  // recent/season blend (same recencyWeight as elsewhere) when recent
  // data exists; otherwise fall back to season-only.
  const observedAvgMinsPerApp =
    input.recentAvgMinsPerApp != null
      ? recencyWeight * input.recentAvgMinsPerApp +
        (1 - recencyWeight) * (input.seasonAvgMinsPerApp ?? input.recentAvgMinsPerApp)
      : (input.seasonAvgMinsPerApp ?? 65);
  // Probability the player will appear at all (start OR sub).
  const appearanceProb = clamp01(startProb + subProb);
  const observedExpectedMinutes = appearanceProb * Math.min(observedAvgMinsPerApp, cap);

  // §team-motivation multiplier — relegated/safe teams rest starters,
  // teams with stakes don't. teamMotivation ~0.7 default → 1.0 multiplier;
  // 0.0 (no stakes at all, e.g. final-GW dead rubber) → 0.75 mult;
  // 1.0 (max stakes) → 1.10 mult.
  // §dead-rubber-fix — downside widened from -7% to -25% because the
  // previous magnitude underweighted final-GW rotation reality. Real
  // dead rubbers see ~30-50% of starters rested or pulled at 60'. A
  // -25% cap is still conservative.
  const motivation = input.teamMotivation ?? 0.7;
  const motivationMultiplier = motivation >= 0.7
    ? 1.0 + 0.10 * Math.min(1, (motivation - 0.7) / 0.3)   // 0.7→1.0, 1.0→1.10
    : 1.0 - 0.25 * Math.min(1, (0.7 - motivation) / 0.7);   // 0.7→1.0, 0→0.75
  if (motivation < 0.7) {
    reasons.push({
      kind: 'team_motivation',
      weight: 1 - motivationMultiplier,
      detail: `team has little to play for (motivation ${(motivation*100).toFixed(0)}%) — minutes/start downweighted ${((1-motivationMultiplier)*100).toFixed(0)}%`,
    });
  }

  // §injury depth — when teammates are out, the available starters play
  // more (no fresh bench legs to rotate in). +2% per missing starter,
  // capped at +10% (5+ injuries).
  const injuredCount = Math.min(5, Math.max(0, input.teamInjuredStarters ?? 0));
  const injuryDepthMultiplier = 1.0 + 0.02 * injuredCount;
  if (injuredCount >= 2) {
    reasons.push({ kind: 'team_injuries', weight: injuryDepthMultiplier - 1, detail: `${injuredCount} teammates out — fewer rotation options` });
  }

  // §floor — the final answer is the MAX of structural vs observed, then
  // adjusted by motivation + injury depth. We use MAX (not blend) because
  // observed is empirical truth and structural is theoretical; if the
  // player actually plays 87 mins on average we shouldn't predict less
  // than that, only more (for stake/injury reasons).
  const baseMinutes = Math.max(structuralExpectedMinutes, observedExpectedMinutes);
  const expectedMinutes = Math.min(
    cap,
    baseMinutes * motivationMultiplier * injuryDepthMultiplier
  );

  // 7. Confidence -------------------------------------------------------------
  // Higher current-season sample + higher reliability => higher confidence.
  const confidence = clamp01(
    0.5 * input.reliability +
    0.3 * Math.min(1, input.currentSeasonAppearanceRate * 1.5) +
    0.2 * (input.manualMinutesCap ? 0.4 : 1.0)        // manual cap means uncertainty
  );

  // Observed rotation: the inverse of the player's actual start rate. A
  // player who has started 95% of recent matches has 5% observed-rotation;
  // someone splitting starts 50/50 has 50%. This is the dominant signal
  // when there are no forward-looking penalties (e.g. late-season fixtures
  // after European competition ends) — without it, rotationRisk collapses
  // to 0 for everyone and the UI shows green badges for genuine rotation
  // risks. Weighted at 0.8 so a perfect 100% starter still surfaces as ~0%
  // and a 40% starter surfaces as ~48% — landing them in the yellow zone.
  const observedStartRate = Math.max(
    input.recentStartRate ?? input.currentSeasonStartRate,
    input.currentSeasonStartRate
  );
  const observedRotation = 0.8 * (1 - clamp01(observedStartRate));

  return {
    startProb,
    sixtyPlusProb,
    ninetyProb,
    subProb,
    benchUnusedProb,
    injuryAbsenceProb,
    expectedMinutes,
    earlySubRisk,
    rotationRisk: clamp01(
      observedRotation
      + rotationPenalty
      + input.competitorPressure * 0.5
    ),
    rotationResistance: input.rotationResistance,
    reliability: input.reliability,
    confidence,
    reasons
  };
}

/**
 * Run the engine for every upcoming fixture in the given gameweek and persist
 * the distribution.
 *
 * Batched implementation: 4 SELECTs + 1 bulk INSERT regardless of player count.
 *   1. SELECT fixtures + their kickoff times
 *   2. SELECT all (player, team, status) for the teams involved
 *   3. SELECT all player history aggregates in one query
 *   4. SELECT all manual overrides for those players
 *   (european_fixtures filtered in JS — typically a handful of rows total)
 *   5. Compute distribution per (player, fixture) in JS
 *   6. Bulk INSERT all rows in one round-trip
 */
export async function recomputeMinutesForGameweek(gw: number) {
  const fixtures = await sql<Array<{
    id: number; team_h: number; team_a: number; kickoff_time: string | null;
  }>>`
    SELECT id, team_h, team_a, kickoff_time
    FROM fixtures
    WHERE gameweek_id = ${gw} AND finished = FALSE
  `;
  if (fixtures.length === 0) return 0;

  const teamIds = Array.from(new Set(fixtures.flatMap(f => [f.team_h, f.team_a])));
  if (teamIds.length === 0) return 0;

  // All players on either side, with their status flags AND season totals from
  // bootstrap. The season columns are the primary evidence source because
  // player_gameweek_history only carries the in-progress GW we ingested live.
  const players = await sql<Array<{
    id: number; team_id: number; status: 'a'|'d'|'i'|'n'|'s'|'u';
    chance_of_playing_next_round: number | null;
    season_minutes: number; season_starts: number;
    news: string | null;
  }>>`
    SELECT id, team_id, status, chance_of_playing_next_round,
           season_minutes, season_starts, news
    FROM players WHERE team_id IN ${sql(teamIds as any)}
  `;
  const playerIds = players.map(p => p.id);

  // Games played per team — denominator for start/appearance rates.
  const teamGames = await sql<Array<{ team_id: number; games: number }>>`
    SELECT t.id AS team_id,
           COUNT(DISTINCT f.id) FILTER (WHERE f.finished = TRUE)::int AS games
    FROM teams t
    LEFT JOIN fixtures f ON (f.team_h = t.id OR f.team_a = t.id)
    WHERE t.id IN ${sql(teamIds as any)}
    GROUP BY t.id
  `;
  const gamesByTeam = new Map(teamGames.map(t => [t.team_id, Math.max(1, t.games)]));

  // Career aggregates per player from in-database history (best-effort: this
  // only carries games we've ingested via live event, not the full season).
  // We blend this with the season totals from `players` above.
  const aggs = playerIds.length === 0 ? [] : await sql<Array<{
    player_id: number; appearances: number; starts: number; ninety: number;
    eligible: number; congestion_starts: number; congestion_eligible: number;
    early_off: number;
  }>>`
    SELECT
      pgh.player_id,
      COUNT(*) FILTER (WHERE pgh.minutes > 0)::int       AS appearances,
      COUNT(*) FILTER (WHERE pgh.starts = 1)::int        AS starts,
      COUNT(*) FILTER (WHERE pgh.minutes >= 90)::int     AS ninety,
      COUNT(*)::int                                      AS eligible,
      COUNT(*) FILTER (WHERE pgh.starts = 1 AND f.kickoff_time IS NOT NULL)::int AS congestion_starts,
      COUNT(*) FILTER (WHERE TRUE)::int                  AS congestion_eligible,
      COUNT(*) FILTER (WHERE pgh.minutes BETWEEN 1 AND 59)::int AS early_off
    FROM player_gameweek_history pgh
    LEFT JOIN fixtures f ON f.id = pgh.fixture_id
    WHERE pgh.player_id IN ${sql(playerIds as any)}
    GROUP BY pgh.player_id
  `;
  const aggByPlayer = new Map(aggs.map(a => [a.player_id, a]));

  // §yc-suspension — Premier League yellow-card thresholds:
  //   5 yellows in first 19 PL matches → 1-match ban
  //   10 yellows in first 32 PL matches → 2-match ban
  //   15 yellows by end of season → 3-match ban
  // Detection rule: if cumulative yellow_cards through the LAST FINISHED
  // GW crossed a multiple of 5 in that GW (i.e. it landed exactly at 5, 10,
  // or 15), the player serves a ban in the NEXT GW. Cross-check against
  // FPL's status — if FPL has already flipped to 's', we don't need this.
  // But if FPL is lagging, this catches it.
  const ycSuspended = new Set<number>();
  if (playerIds.length > 0) {
    const ycRows = await sql<Array<{
      player_id: number; cum_yc_total: number; cum_yc_before_last: number;
    }>>`
      WITH match_yc AS (
        SELECT pgh.player_id, pgh.gameweek_id, pgh.yellow_cards,
               (SELECT MAX(gameweek_id) FROM fixtures WHERE finished = TRUE) AS last_gw
        FROM player_gameweek_history pgh
        JOIN fixtures f ON f.id = pgh.fixture_id
        WHERE f.finished = TRUE
          AND pgh.player_id IN ${sql(playerIds as any)}
      )
      SELECT player_id,
             SUM(yellow_cards)::int AS cum_yc_total,
             SUM(CASE WHEN gameweek_id < last_gw THEN yellow_cards ELSE 0 END)::int AS cum_yc_before_last
      FROM match_yc
      GROUP BY player_id
    `;
    for (const r of ycRows) {
      // Did the cumulative count CROSS a 5/10/15 boundary in the last GW?
      // before-last must be < threshold AND total must be >= threshold.
      const before = r.cum_yc_before_last;
      const total  = r.cum_yc_total;
      const crossed5  = before < 5  && total >= 5;
      const crossed10 = before < 10 && total >= 10;
      const crossed15 = before < 15 && total >= 15;
      if (crossed5 || crossed10 || crossed15) {
        ycSuspended.add(r.player_id);
      }
    }
  }

  // Recent per-match rows per player — the last 5 played fixtures. Powers
  // recency-weighted start/ninety/appearance rates so a player who was nailed
  // earlier in the season but recently benched gets a falling startProb, not
  // his season average.
  const recentMatchRows = playerIds.length === 0 ? [] : await sql<Array<{
    player_id: number; gameweek_id: number;
    minutes: number; starts: number;
  }>>`
    SELECT player_id, gameweek_id, minutes, starts FROM (
      SELECT pgh.player_id, pgh.gameweek_id, pgh.minutes, pgh.starts,
             ROW_NUMBER() OVER (PARTITION BY pgh.player_id ORDER BY pgh.gameweek_id DESC) AS rn
      FROM player_gameweek_history pgh
      JOIN fixtures f ON f.id = pgh.fixture_id
      WHERE f.finished = TRUE
        AND pgh.player_id IN ${sql(playerIds as any)}
    ) sub
    WHERE rn <= 5
    ORDER BY player_id, gameweek_id DESC
  `;
  const recentByPlayer = new Map<number, Array<{ minutes: number; starts: number }>>();
  for (const r of recentMatchRows) {
    const arr = recentByPlayer.get(r.player_id) ?? [];
    arr.push({ minutes: Number(r.minutes), starts: Number(r.starts) });
    recentByPlayer.set(r.player_id, arr);
  }

  // Manual overrides for these players — single query.
  const overrides = playerIds.length === 0 ? [] : await sql<Array<{
    scope_id: number; kind: string; value: any;
  }>>`
    SELECT scope_id, kind, value FROM manual_overrides
    WHERE scope = 'player' AND active = TRUE
      AND scope_id IN ${sql(playerIds as any)}
      AND (expires_at IS NULL OR expires_at > now())
  `;
  const overridesByPlayer = new Map<number, Array<{ kind: string; value: any }>>();
  for (const o of overrides) {
    if (!overridesByPlayer.has(o.scope_id)) overridesByPlayer.set(o.scope_id, []);
    overridesByPlayer.get(o.scope_id)!.push({ kind: o.kind, value: o.value });
  }

  // §team-motivation — pull motivation_score per team. ~0.7 default
  // mid-season; collapses to 0.1-0.3 for relegated/safe teams in the
  // final 3 GWs; pushes to 1.0 for top-4 chase / relegation fight.
  const teamMotivationRows = teamIds.length === 0 ? [] : await sql<Array<{
    id: number; motivation_score: number | null;
  }>>`
    SELECT id, motivation_score FROM teams WHERE id IN ${sql(teamIds as any)}
  `;
  const teamMotivationByTeam = new Map<number, number>();
  for (const t of teamMotivationRows) {
    if (t.motivation_score != null) {
      teamMotivationByTeam.set(t.id, Number(t.motivation_score));
    }
  }

  // §injured-starters — count of teammates currently OUT (status='i' or
  // 'u') OR doubtful (chance_of_playing_next_round <= 50). This is the
  // depth signal: fewer healthy alternatives → starters play more mins.
  const injuredCountByTeam = new Map<number, number>();
  for (const p of players) {
    const isOut = p.status === 'i' || p.status === 'u'
      || (p.status === 'd' && (p.chance_of_playing_next_round ?? 100) <= 50);
    if (!isOut) continue;
    // Only count "starter-grade" missing players — those who normally play
    // 60+ mins/app. A 4th-choice CB being out doesn't reduce rotation
    // options for the front line. Use season_minutes / season_starts.
    const startsAvg = (Number(p.season_starts) || 0) > 0
      ? (Number(p.season_minutes) || 0) / (Number(p.season_starts) || 1)
      : 0;
    if (startsAvg < 50) continue;
    injuredCountByTeam.set(p.team_id, (injuredCountByTeam.get(p.team_id) ?? 0) + 1);
  }

  // European fixtures within the GW window — small table, one query.
  const euFixtures = teamIds.length === 0 ? [] : await sql<Array<{
    team_id: number; kickoff_time: string;
  }>>`
    SELECT team_id, kickoff_time FROM european_fixtures
    WHERE team_id IN ${sql(teamIds as any)}
  `;

  const rows: any[] = [];
  for (const fix of fixtures) {
    const kickoff = fix.kickoff_time ? new Date(fix.kickoff_time).getTime() : null;
    const fixturePlayers = players.filter(p => p.team_id === fix.team_h || p.team_id === fix.team_a);

    for (const p of fixturePlayers) {
      const agg = aggByPlayer.get(p.id);
      // Use the bigger of the two: live-ingested games for this season OR the
      // team's elapsed gameweek count. Season totals span the full PL year,
      // so the team's games-played is the right denominator.
      const eligible = Math.max(agg?.eligible ?? 0, gamesByTeam.get(p.team_id) ?? 0);
      const seasonStarts = Number(p.season_starts) || 0;
      const seasonMinutes = Number(p.season_minutes) || 0;
      // Approximate appearances: starts plus any extra minutes appearances
      // (rough but close — every started match is one appearance, and bench
      // cameos add ~20 mins each).
      const approxAppearances = Math.min(
        eligible,
        seasonStarts + Math.max(0, Math.round((seasonMinutes - seasonStarts * 65) / 25))
      );
      const approxNinety = seasonStarts === 0
        ? 0
        : Math.min(seasonStarts, Math.round(seasonMinutes / 90));

      const reliabilityInput = {
        appearancesAvailable: Math.max(approxAppearances, agg?.appearances ?? 0),
        totalAvailable:       eligible,
        startsAvailable:      Math.max(seasonStarts, agg?.starts ?? 0),
        ninetyMinutesPlayed:  Math.max(approxNinety, agg?.ninety ?? 0),
        earlySubOffCount:     agg?.early_off ?? 0,
        congestionStarts:     agg?.congestion_starts ?? 0,
        congestionEligible:   agg?.congestion_eligible ?? 0
      };
      const reliability = computeReliability(reliabilityInput);
      const rotationResistance = computeRotationResistance(reliabilityInput);

      // EU context — compute against the in-memory list.
      let postEu = false, preEu = false;
      if (kickoff != null) {
        for (const e of euFixtures) {
          if (e.team_id !== p.team_id) continue;
          const ekt = new Date(e.kickoff_time).getTime();
          const deltaDays = Math.abs(kickoff - ekt) / (1000 * 60 * 60 * 24);
          if (deltaDays > 4) continue;
          if (ekt < kickoff) postEu = true; else preEu = true;
        }
      }

      const playerOv = overridesByPlayer.get(p.id) ?? [];
      const manualCap = playerOv.find(o => o.kind === 'minutes_cap')?.value?.cap as number | undefined;
      const manualAbsence = playerOv.some(o => o.kind === 'availability' && o.value?.expected === 'out');

      const startRate      = eligible > 0 ? reliabilityInput.startsAvailable / eligible : 0;
      const ninetyRate     = reliabilityInput.startsAvailable > 0
        ? reliabilityInput.ninetyMinutesPlayed / reliabilityInput.startsAvailable
        : 0;
      const appearanceRate = eligible > 0 ? reliabilityInput.appearancesAvailable / eligible : 0;

      // Recency-weighted rates over the last 5 played fixtures. Decay 0.6
      // per step → weights [1.0, 0.6, 0.36, 0.22, 0.13], effN ≤ 2.31.
      // §observed-mins-floor — also accumulate weighted total minutes so
      // we can compute the average minutes-per-appearance over recent.
      const recent = recentByPlayer.get(p.id) ?? [];
      let rN = 0, rS = 0, rA = 0, rNine = 0, rStartedAcc = 0;
      let rMinsTotal = 0, rApperanceWeights = 0;
      let w = 1;
      for (const m of recent) {
        const started = m.starts > 0 ? 1 : 0;
        const appeared = m.minutes > 0 ? 1 : 0;
        const ninety = m.minutes >= 90 ? 1 : 0;
        rS += w * started;
        rA += w * appeared;
        if (started) {
          rNine += w * ninety;
          rStartedAcc += w;
        }
        if (appeared) {
          // Only count matches where the player actually appeared. A DNP
          // shouldn't drag the avg-mins-per-app down — that's what
          // appearanceProb handles upstream.
          rMinsTotal += w * m.minutes;
          rApperanceWeights += w;
        }
        rN += w;
        w *= 0.6;
      }
      const recentStartRate      = rN > 0 ? rS / rN : undefined;
      const recentAppearanceRate = rN > 0 ? rA / rN : undefined;
      const recentNinetyRate     = rStartedAcc > 0 ? rNine / rStartedAcc : undefined;
      const recentAvgMinsPerApp  = rApperanceWeights > 0
        ? rMinsTotal / rApperanceWeights
        : undefined;

      // §season-avg-mins-per-app — total minutes ÷ appearances, NOT ÷
      // games-played. A player who logs 2700 mins in 32 appearances
      // averages 84 mins/app; the rate is what matters for predicting
      // the NEXT appearance, not their start frequency.
      const seasonAvgMinsPerApp = reliabilityInput.appearancesAvailable > 0
        ? seasonMinutes / reliabilityInput.appearancesAvailable
        : undefined;

      // §team-motivation — pulled from teams.motivation_score (recomputed
      // weekly by team-context.ts). 0..1 scale; ~0.7 default mid-season,
      // collapses to 0.1-0.3 for relegated/safe teams in final 3 GWs,
      // pushes to 1.0 for top-4 chase / relegation fight.
      const teamMotivation = teamMotivationByTeam.get(p.team_id);

      // §injured-starters — count teammates with FPL status 'i', 'u', or
      // doubt (chance_of_playing_next_round <= 50). Pulled from the
      // already-loaded players list filtered to same team.
      const teamInjuredStarters = injuredCountByTeam.get(p.team_id) ?? 0;

      const distribution = projectMinutes({
        playerId: p.id, fixtureId: fix.id,
        reliability, rotationResistance,
        currentSeasonStartRate: startRate,
        currentSeasonNinetyRate: ninetyRate,
        currentSeasonAppearanceRate: appearanceRate,
        recentStartRate, recentNinetyRate, recentAppearanceRate,
        recentStartSample: rN,
        recentAvgMinsPerApp,
        seasonAvgMinsPerApp,
        teamMotivation,
        teamInjuredStarters,
        fplStatus: p.status,
        chanceOfPlayingNext: p.chance_of_playing_next_round,
        fplNews: p.news,
        ycSuspendedNext: ycSuspended.has(p.id),
        isPostEuropeanFixture: postEu,
        isPreEuropeanFixture:  preEu,
        daysRestBefore: null, daysRestAfter: null,
        fixtureImportance: 1.0,
        competitorPressure: 0,
        returnFromInjuryMatch: null,
        manualMinutesCap: manualCap,
        manualExpectedAbsence: manualAbsence
      });

      rows.push({
        player_id: p.id,
        fixture_id: fix.id,
        start_prob: distribution.startProb,
        sixty_plus_prob: distribution.sixtyPlusProb,
        ninety_prob: distribution.ninetyProb,
        sub_prob: distribution.subProb,
        bench_unused_prob: distribution.benchUnusedProb,
        injury_absence_prob: distribution.injuryAbsenceProb,
        expected_minutes: distribution.expectedMinutes,
        early_sub_risk: distribution.earlySubRisk,
        rotation_risk: distribution.rotationRisk,
        rotation_resistance: distribution.rotationResistance,
        minutes_confidence: distribution.confidence,
        reliability_index: distribution.reliability,
        // Pass the array directly. postgres.js detects the JSONB column type
        // and serializes once. Stringifying here causes a double-encode and
        // corrupts the stored value as a JSON-string of a JSON-string.
        reasons: distribution.reasons,
        computed_at: new Date()
      });
    }
  }

  if (rows.length === 0) return fixtures.length;
  await sql`
    INSERT INTO minutes_projections ${(sql as any)(rows,
      'player_id', 'fixture_id', 'start_prob', 'sixty_plus_prob', 'ninety_prob',
      'sub_prob', 'bench_unused_prob', 'injury_absence_prob', 'expected_minutes',
      'early_sub_risk', 'rotation_risk', 'rotation_resistance', 'minutes_confidence',
      'reliability_index', 'reasons', 'computed_at')}
    ON CONFLICT (player_id, fixture_id) DO UPDATE SET
      start_prob = EXCLUDED.start_prob,
      sixty_plus_prob = EXCLUDED.sixty_plus_prob,
      ninety_prob = EXCLUDED.ninety_prob,
      sub_prob = EXCLUDED.sub_prob,
      bench_unused_prob = EXCLUDED.bench_unused_prob,
      injury_absence_prob = EXCLUDED.injury_absence_prob,
      expected_minutes = EXCLUDED.expected_minutes,
      early_sub_risk = EXCLUDED.early_sub_risk,
      rotation_risk = EXCLUDED.rotation_risk,
      rotation_resistance = EXCLUDED.rotation_resistance,
      minutes_confidence = EXCLUDED.minutes_confidence,
      reliability_index = EXCLUDED.reliability_index,
      reasons = EXCLUDED.reasons,
      computed_at = now()
  `;
  return fixtures.length;
}
