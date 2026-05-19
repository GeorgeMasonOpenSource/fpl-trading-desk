import { sql } from '@/lib/db/client';

/**
 * Recompute long-term per-90 baselines from player_season_history.
 * Old seasons are weighted down geometrically: 1.0 for most recent prior season,
 * 0.5 for the one before, 0.25 for earlier. New signings (no PL history) inherit
 * positional means as a fallback — they pick up real evidence as the season runs.
 */
export async function recomputeBaselines() {
  // Positional means as a soft prior for new signings (per 90).
  const [defaults] = await sql<Array<{
    gkp_saves: number; def_xa: number; mid_xg: number; mid_xa: number; fwd_xg: number;
  }>>`
    SELECT
      0.30 AS gkp_saves,
      0.05 AS def_xa,
      0.10 AS mid_xg,
      0.10 AS mid_xa,
      0.30 AS fwd_xg
  `;

  const players = await sql<Array<{
    player_id: number; position: string;
  }>>`SELECT id AS player_id, position FROM players`;

  for (const p of players) {
    const seasons = await sql<Array<{
      season_name: string; minutes: number; expected_goals: number;
      expected_assists: number; bonus: number; clean_sheets: number;
      yellow_cards: number; red_cards: number;
    }>>`
      SELECT season_name, minutes, expected_goals, expected_assists,
             bonus, clean_sheets, yellow_cards, red_cards
      FROM player_season_history
      WHERE player_id = ${p.player_id}
      ORDER BY season_name DESC
      LIMIT 4
    `;

    let totalW = 0;
    let xgPer90 = 0, xaPer90 = 0, bonusPer90 = 0, csShare = 0;
    let yel90 = 0, red90 = 0;
    let sampleMinutes = 0;
    for (let i = 0; i < seasons.length; i++) {
      const w = Math.pow(0.5, i);
      const s = seasons[i];
      const mins = Math.max(1, s.minutes);
      xgPer90    += w * (s.expected_goals    * 90 / mins);
      xaPer90    += w * (s.expected_assists  * 90 / mins);
      bonusPer90 += w * (s.bonus             * 90 / mins);
      csShare    += w * (s.clean_sheets      / Math.max(1, mins / 90));
      yel90      += w * (s.yellow_cards      * 90 / mins);
      red90      += w * (s.red_cards         * 90 / mins);
      totalW += w;
      sampleMinutes += s.minutes;
    }
    if (totalW === 0) {
      // No history — fall back to positional defaults.
      xgPer90 = p.position === 'FWD' ? defaults.fwd_xg : p.position === 'MID' ? defaults.mid_xg : 0.03;
      xaPer90 = p.position === 'FWD' ? 0.07 : p.position === 'MID' ? defaults.mid_xa : defaults.def_xa;
      bonusPer90 = 0.20;
      csShare = p.position === 'DEF' || p.position === 'GKP' ? 0.30 : 0.10;
      totalW = 1;
    } else {
      xgPer90 /= totalW; xaPer90 /= totalW; bonusPer90 /= totalW; csShare /= totalW;
      yel90 /= totalW; red90 /= totalW;
    }

    await sql`
      INSERT INTO player_baselines (player_id,
        baseline_minutes_per_app, baseline_start_rate,
        baseline_xg_per_90, baseline_xa_per_90, baseline_xgi_per_90,
        baseline_bonus_per_90, baseline_cs_share,
        baseline_yellow_per_90, baseline_red_per_90,
        baseline_saves_per_90, baseline_pen_save_per_90,
        sample_size_minutes, computed_at)
      VALUES (${p.player_id}, 75, 0.7,
              ${xgPer90}, ${xaPer90}, ${xgPer90 + xaPer90},
              ${bonusPer90}, ${csShare}, ${yel90}, ${red90},
              ${p.position === 'GKP' ? defaults.gkp_saves : 0}, 0,
              ${sampleMinutes}, now())
      ON CONFLICT (player_id) DO UPDATE SET
        baseline_xg_per_90 = EXCLUDED.baseline_xg_per_90,
        baseline_xa_per_90 = EXCLUDED.baseline_xa_per_90,
        baseline_xgi_per_90 = EXCLUDED.baseline_xgi_per_90,
        baseline_bonus_per_90 = EXCLUDED.baseline_bonus_per_90,
        baseline_cs_share = EXCLUDED.baseline_cs_share,
        baseline_yellow_per_90 = EXCLUDED.baseline_yellow_per_90,
        baseline_red_per_90 = EXCLUDED.baseline_red_per_90,
        baseline_saves_per_90 = EXCLUDED.baseline_saves_per_90,
        sample_size_minutes = EXCLUDED.sample_size_minutes,
        computed_at = now()
    `;
  }
  return players.length;
}
