import { sql } from '@/lib/db/client';

/**
 * Recompute long-term per-90 baselines from player_season_history.
 *
 * Earlier version ran ~1,400 sequential round-trips (1 SELECT + 1 INSERT per
 * player × 700). This version is 3 round-trips total:
 *   1. SELECT all players in one go
 *   2. SELECT all (player, season) history rows in one go
 *   3. Single bulk INSERT with ON CONFLICT DO UPDATE
 *
 * Old seasons are weighted geometrically: 1.0 for most recent prior season,
 * 0.5 for the one before, 0.25 for earlier. New signings (no PL history)
 * inherit positional means as a fallback.
 */
export async function recomputeBaselines() {
  const players = await sql<Array<{ player_id: number; position: 'GKP'|'DEF'|'MID'|'FWD' }>>`
    SELECT id AS player_id, position FROM players
  `;
  type Hist = { player_id: number; season_name: string; minutes: number;
                expected_goals: number; expected_assists: number; bonus: number;
                clean_sheets: number; yellow_cards: number; red_cards: number; };
  const history: Hist[] = await sql<Hist[]>`
    SELECT player_id, season_name, minutes, expected_goals, expected_assists,
           bonus, clean_sheets, yellow_cards, red_cards
    FROM player_season_history
    ORDER BY player_id, season_name DESC
  `;

  // Group history by player.
  const byPlayer = new Map<number, Hist[]>();
  for (const h of history) {
    if (!byPlayer.has(h.player_id)) byPlayer.set(h.player_id, []);
    byPlayer.get(h.player_id)!.push(h);
  }

  // Positional fallback priors for new signings.
  const defaults = { gkp_saves: 0.30, def_xa: 0.05, mid_xg: 0.10, mid_xa: 0.10, fwd_xg: 0.30 };

  const rows = players.map(p => {
    const seasons = (byPlayer.get(p.player_id) ?? []).slice(0, 4);
    let totalW = 0, xgPer90 = 0, xaPer90 = 0, bonusPer90 = 0, csShare = 0;
    let yel90 = 0, red90 = 0, sampleMinutes = 0;
    for (let i = 0; i < seasons.length; i++) {
      const w = Math.pow(0.5, i);
      const s = seasons[i];
      const mins = Math.max(1, Number(s.minutes));
      xgPer90    += w * (Number(s.expected_goals)   * 90 / mins);
      xaPer90    += w * (Number(s.expected_assists) * 90 / mins);
      bonusPer90 += w * (Number(s.bonus)            * 90 / mins);
      csShare    += w * (Number(s.clean_sheets)     / Math.max(1, mins / 90));
      yel90      += w * (Number(s.yellow_cards)     * 90 / mins);
      red90      += w * (Number(s.red_cards)        * 90 / mins);
      totalW += w;
      sampleMinutes += Number(s.minutes);
    }
    if (totalW === 0) {
      xgPer90 = p.position === 'FWD' ? defaults.fwd_xg : p.position === 'MID' ? defaults.mid_xg : 0.03;
      xaPer90 = p.position === 'FWD' ? 0.07           : p.position === 'MID' ? defaults.mid_xa : defaults.def_xa;
      bonusPer90 = 0.20;
      csShare = p.position === 'DEF' || p.position === 'GKP' ? 0.30 : 0.10;
      totalW = 1;
    } else {
      xgPer90 /= totalW; xaPer90 /= totalW; bonusPer90 /= totalW; csShare /= totalW;
      yel90 /= totalW; red90 /= totalW;
    }
    return {
      player_id: p.player_id,
      baseline_minutes_per_app: 75,
      baseline_start_rate: 0.7,
      baseline_xg_per_90: xgPer90,
      baseline_xa_per_90: xaPer90,
      baseline_xgi_per_90: xgPer90 + xaPer90,
      baseline_bonus_per_90: bonusPer90,
      baseline_cs_share: csShare,
      baseline_yellow_per_90: yel90,
      baseline_red_per_90: red90,
      baseline_saves_per_90: p.position === 'GKP' ? defaults.gkp_saves : 0,
      baseline_pen_save_per_90: 0,
      sample_size_minutes: sampleMinutes,
      computed_at: new Date()
    };
  });

  if (rows.length === 0) return 0;
  await sql`
    INSERT INTO player_baselines ${sql(rows,
      'player_id', 'baseline_minutes_per_app', 'baseline_start_rate',
      'baseline_xg_per_90', 'baseline_xa_per_90', 'baseline_xgi_per_90',
      'baseline_bonus_per_90', 'baseline_cs_share',
      'baseline_yellow_per_90', 'baseline_red_per_90',
      'baseline_saves_per_90', 'baseline_pen_save_per_90',
      'sample_size_minutes', 'computed_at')}
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
  return rows.length;
}
