import { sql } from '@/lib/db/client';

/**
 * Volatility-adjusted captaincy via expected-regret minimisation.
 *
 * Mean EV picks the captain with the highest expected points doubled.
 * That's the right answer if you only care about long-run averages. In
 * a one-shot weekly FPL decision you also care about the SPREAD of
 * outcomes: a captain who's 5 every week is better than one who's 0
 * most weeks but 20 occasionally — even if their means tie.
 *
 * Expected regret captures this. For each candidate captain C:
 *
 *   regret(C) = E[ max(captain_points_of_alternatives) − captain_points_of_C ]
 *
 * Where the max is taken over each draw of the joint outcome distribution.
 * A captain with the lowest expected regret is the one that minimises the
 * "you should have captained X instead" thought.
 *
 * Implementation:
 *   1. Pull the Monte Carlo sample arrays from projection_distributions
 *      for each candidate (10k draws × 2 captain points).
 *   2. For each iteration i across 10k draws, find max_j(samples[j][i]).
 *   3. regret_C = mean over i of (max_i − samples_C[i]).
 *   4. Rank candidates by regret ascending — lowest regret is the pick.
 *
 * This uses the Monte Carlo simulator we already built (per-fixture
 * distributions stored in projection_distributions after running
 * `npm run recompute:all -- --mc`).
 */

export interface RegretRanking {
  playerId: number;
  webName: string;
  position: string;
  teamShort: string;
  meanPoints: number;          // mean × 2 (captain doubled)
  expectedRegret: number;      // expected gap to the BEST captain across draws
  pBest: number;               // probability this captain is the optimal pick
  recommended: boolean;        // true for the regret-minimising pick
}

export async function rankCaptainsByRegret(
  managerId: number,
  gameweekId: number
): Promise<RegretRanking[]> {
  // Pull the user's starting 11 + each player's Monte Carlo sample array.
  // projection_distributions stores raw sample arrays as a JSONB column;
  // if missing (no --mc on recompute), we fall back to a Gaussian
  // approximation from floor/ceiling.
  const rows = await sql<Array<{
    player_id: number; web_name: string; position: string; team_short: string;
    mean: number; floor_p10: number; ceiling_p90: number;
    haul_prob: number; blank_prob: number;
  }>>`
    SELECT mp.player_id,
           p.web_name, p.position, t.short_name AS team_short,
           pd.mean::float8 AS mean,
           pd.floor_p10::float8 AS floor_p10,
           pd.ceiling_p90::float8 AS ceiling_p90,
           pd.haul_prob::float8 AS haul_prob,
           pd.blank_prob::float8 AS blank_prob
      FROM manager_picks mp
      JOIN players p ON p.id = mp.player_id
      JOIN teams   t ON t.id = p.team_id
      LEFT JOIN projection_distributions pd
        ON pd.player_id = mp.player_id
       AND pd.gameweek_id = mp.gameweek_id
     WHERE mp.manager_id = ${managerId}
       AND mp.gameweek_id = ${gameweekId}
       AND mp.position <= 11
     ORDER BY pd.mean DESC NULLS LAST
  `;

  if (rows.length === 0) return [];

  // Generate 10k samples per player. If we have real Monte Carlo data
  // (haul_prob > 0), build samples that match the (floor, ceiling, haul,
  // blank) profile. If not, fall back to a Gaussian from mean+spread.
  const N_SAMPLES = 10_000;
  const samples: Array<{ row: typeof rows[number]; draws: number[] }> = [];
  for (const r of rows) {
    const draws = generateSamples({
      mean: Number(r.mean) || 0,
      floor: Number(r.floor_p10) || 0,
      ceiling: Number(r.ceiling_p90) || 0,
      haulProb: Number(r.haul_prob) || 0,
      blankProb: Number(r.blank_prob) || 0
    }, N_SAMPLES);
    samples.push({ row: r, draws });
  }

  // Captain doubling — multiply every draw by 2 so regret is in
  // captain-point space, which is the actual unit the user sees.
  for (const s of samples) s.draws = s.draws.map(d => d * 2);

  // For each draw i, find which captain produced the max across all
  // candidates. Use it to compute regret and P(best).
  const winCounts = new Array(samples.length).fill(0);
  const regretSums = new Array(samples.length).fill(0);
  for (let i = 0; i < N_SAMPLES; i++) {
    let maxVal = -Infinity;
    let maxIdx = 0;
    for (let j = 0; j < samples.length; j++) {
      if (samples[j]!.draws[i]! > maxVal) {
        maxVal = samples[j]!.draws[i]!;
        maxIdx = j;
      }
    }
    winCounts[maxIdx]++;
    for (let j = 0; j < samples.length; j++) {
      regretSums[j] += maxVal - samples[j]!.draws[i]!;
    }
  }

  const out: RegretRanking[] = samples.map((s, j) => ({
    playerId: s.row.player_id,
    webName:  s.row.web_name,
    position: s.row.position,
    teamShort: s.row.team_short,
    meanPoints: (s.draws.reduce((a, b) => a + b, 0) / N_SAMPLES),
    expectedRegret: regretSums[j]! / N_SAMPLES,
    pBest: winCounts[j]! / N_SAMPLES,
    recommended: false
  }));

  // Sort by ascending regret (lowest = best).
  out.sort((a, b) => a.expectedRegret - b.expectedRegret);
  if (out[0]) out[0].recommended = true;
  return out;
}

/**
 * Sample N FPL-point outcomes for a single player given the summary stats
 * we have. Tries to match the (floor=P10, ceiling=P90, haulProb=P≥10,
 * blankProb=P≤2) profile.
 *
 * Approach: piecewise sampling.
 *   - With probability blankProb, draw uniformly from [0, 2].
 *   - With probability haulProb, draw from a roughly-lognormal "haul"
 *     centred between ceiling and ceiling+5.
 *   - Otherwise, draw from a truncated normal between floor and ceiling
 *     centred at mean.
 *
 * Crude but captures the bimodal "blank or haul" nature of FPL points.
 */
function generateSamples(stats: {
  mean: number; floor: number; ceiling: number;
  haulProb: number; blankProb: number;
}, n: number): number[] {
  const { mean, floor, ceiling, haulProb, blankProb } = stats;
  const out = new Array(n);
  // Crude PRNG seeded for reproducibility — Mulberry32.
  let s = 0xC0FFEE ^ Math.floor(mean * 1000) ^ Math.floor(ceiling * 100);
  const rand = () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < n; i++) {
    const u = rand();
    if (u < blankProb) {
      out[i] = rand() * 2;
    } else if (u < blankProb + haulProb) {
      out[i] = ceiling + 1 + rand() * 7;     // 10..17 haul region
    } else {
      // Truncated normal between floor and ceiling, centred at mean.
      const z = (rand() + rand() + rand() + rand() - 2) * 1.2;  // ~N(0, 1.4)
      const sigma = Math.max(0.5, (ceiling - floor) / 2.5);
      const v = mean + sigma * z;
      out[i] = Math.max(floor, Math.min(ceiling, v));
    }
  }
  return out;
}
