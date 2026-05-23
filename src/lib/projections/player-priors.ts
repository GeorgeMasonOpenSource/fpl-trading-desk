import { sql } from '@/lib/db/client';

/**
 * Per-player Bayesian priors.
 *
 * Captures individual finishing/creation/bonus tendencies that the
 * position-level calibration can't see. Two specific failure modes
 * this fixes:
 *
 *   1. Elite finishers (Haaland-tier): convert xG at 1.05-1.15× the
 *      league mean. Without this, our goals component under-predicts
 *      them even when team_xg_for is accurate.
 *
 *   2. Bonus magnets (Bowen, Mbeumo, Saka): consistently rack up more
 *      bonus than their BPS-from-xG would suggest, because they take
 *      key passes, complete dribbles, draw fouls — none of which our
 *      xG-driven engine sees.
 *
 * The math is Bayesian shrinkage in log-space:
 *
 *   raw_mult  = (actual / expected),  in log space for symmetry
 *   shrunk    = raw × n / (n + prior_weight)
 *   final     = clamp(exp(shrunk), 0.7, 1.4)
 *
 * n = effective 90s of data we have on this player this season.
 * prior_weight = 8 — i.e. a player with 8 starts gets 50% of their
 * raw signal, 30 starts gets ~ 80%, 50+ starts gets ~ 90%.
 *
 * Clamp at [0.7, 1.4] so even with 100 starts of perfect finishing
 * we never claim a 2× multiplier — the residual would be a model
 * error elsewhere, not a player trait.
 */

const PRIOR_WEIGHT_90S = 8;
const MULT_CLAMP_LO = 0.7;
const MULT_CLAMP_HI = 1.4;
const MIN_MINUTES_FOR_PRIOR = 540;  // 6 full matches — below this we leave mult = 1.0
// xG is noisy in small samples. A DEF with 2 goals on 0.6 xG looks like a
// 3× finisher but the truth is variance. Require enough expected goals
// before fitting goal_mult. Higher bar for DEF/GKP because their xG is
// usually corner-tap-in lottery; MID/FWD see real shot volume.
const MIN_XG_FOR_GOAL_PRIOR: Record<'GKP'|'DEF'|'MID'|'FWD', number> = {
  GKP: 99,    // GKPs don't take shots — never fit a goal mult
  DEF: 2.0,
  MID: 1.5,
  FWD: 2.0,
};
const MIN_XA_FOR_ASSIST_PRIOR = 1.5;
// Bonus mult is the most data-hungry: bonus is granular (1/2/3 points per
// match) and noisy. Require a season's worth of action.
const MIN_BONUS_FOR_BONUS_PRIOR = 5;

export async function recomputePlayerPriors(): Promise<{
  computed: number;
  highMultipliers: Array<{ web_name: string; goal_mult: number; bonus_mult: number; sample90s: number }>;
}> {
  // Ensure table exists (idempotent — covers fresh deploys before migrations run).
  await sql`
    CREATE TABLE IF NOT EXISTS player_priors (
      player_id              INT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      goal_conversion_mult   NUMERIC(4,3) NOT NULL DEFAULT 1.0,
      assist_conversion_mult NUMERIC(4,3) NOT NULL DEFAULT 1.0,
      bonus_per_90_mult      NUMERIC(4,3) NOT NULL DEFAULT 1.0,
      sample_90s             NUMERIC(6,2) NOT NULL DEFAULT 0,
      confidence             NUMERIC(4,3) NOT NULL DEFAULT 0,
      computed_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
    )
  `;

  // Pull season-level actuals + xG aggregates. We use the Understat
  // per-situation xG when available (more accurate than season_xg
  // because it strips pen-xG cleanly); fall back to FPL season_xg.
  const rows = await sql<Array<{
    player_id: number;
    web_name: string;
    position: 'GKP'|'DEF'|'MID'|'FWD';
    season_minutes: number;
    season_goals: number;
    season_assists: number;
    season_bonus: number;
    season_xg: number;
    season_xa: number;
    understat_xg: number | null;
    understat_xa: number | null;
  }>>`
    SELECT
      p.id AS player_id, p.web_name, p.position,
      COALESCE(p.season_minutes, 0)::int   AS season_minutes,
      COALESCE(p.season_goals, 0)::int     AS season_goals,
      COALESCE(p.season_assists, 0)::int   AS season_assists,
      COALESCE(p.season_bonus, 0)::int     AS season_bonus,
      COALESCE(p.season_xg, 0)::float8     AS season_xg,
      COALESCE(p.season_xa, 0)::float8     AS season_xa,
      (psa.xg_open_play + psa.xg_set_piece)::float8 AS understat_xg,
      NULL::float8 AS understat_xa
    FROM players p
    LEFT JOIN player_shot_aggregates psa ON psa.player_id = p.id
  `;

  // Per-player accumulator. We store raw seasons-totals and decide
  // PER-COMPONENT (goal / assist / bonus) whether the sample is large
  // enough to fit a multiplier — if not, that component stays at 1.0.
  // This stops a DEF with 2 goals on 0.6 xG from getting goal_mult=1.4.
  type PlayerFit = {
    player_id: number;
    pos: 'GKP'|'DEF'|'MID'|'FWD';
    mins: number;
    expGoals: number;
    expAssists: number;
    actualGoals: number;
    actualAssists: number;
    seasonBonus: number;
    conv: number;        // (goals+0.5)/(xg+0.5)
    assistConv: number;
    bonus90: number;
  };
  const byPos: Record<'GKP'|'DEF'|'MID'|'FWD', PlayerFit[]> = { GKP: [], DEF: [], MID: [], FWD: [] };

  for (const r of rows) {
    if (r.season_minutes < MIN_MINUTES_FOR_PRIOR) continue;
    const expGoals = r.understat_xg ?? r.season_xg;
    const expAssists = r.season_xa;
    const conv = (r.season_goals + 0.5) / (expGoals + 0.5);
    const assistConv = expAssists > 0.5
      ? (r.season_assists + 0.5) / (expAssists + 0.5)
      : 1.0;
    const bonus90 = (r.season_bonus * 90) / r.season_minutes;
    byPos[r.position].push({
      player_id: r.player_id, pos: r.position, mins: r.season_minutes,
      expGoals, expAssists, actualGoals: r.season_goals, actualAssists: r.season_assists,
      seasonBonus: r.season_bonus, conv, assistConv, bonus90
    });
  }

  // Position medians — but ONLY from players who actually have enough sample
  // to enter that component's fit. Otherwise the DEF "conv" median is
  // dominated by 0.5/1.0 = 0.5 ratios and skews everything upward.
  const medianBy = (arr: number[]) => {
    if (arr.length === 0) return 1;
    const sorted = arr.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 1;
  };
  const medians: Record<string, { conv: number; bonus90: number; assistConv: number }> = {} as any;
  for (const pos of ['GKP', 'DEF', 'MID', 'FWD'] as const) {
    const players = byPos[pos];
    medians[pos] = {
      conv:       medianBy(players.filter(p => p.expGoals    >= MIN_XG_FOR_GOAL_PRIOR[pos]).map(p => p.conv)),
      assistConv: medianBy(players.filter(p => p.expAssists  >= MIN_XA_FOR_ASSIST_PRIOR).map(p => p.assistConv)),
      bonus90:    medianBy(players.filter(p => p.seasonBonus >= MIN_BONUS_FOR_BONUS_PRIOR).map(p => p.bonus90))
    };
  }

  // Fit + persist. Each component independently checks its threshold;
  // sub-threshold components stay at 1.0 (no signal, no nudge).
  const updates: Array<{ player_id: number; web_name: string; goal_mult: number; assist_mult: number; bonus_mult: number; sample90s: number; conf: number }> = [];
  const meta = new Map(rows.map(r => [r.player_id, r]));

  for (const pos of ['GKP', 'DEF', 'MID', 'FWD'] as const) {
    const med = medians[pos];
    for (const p of byPos[pos]) {
      const sample90s = p.mins / 90;
      const w = sample90s / (sample90s + PRIOR_WEIGHT_90S);

      // Goal mult — only if the player has enough expected goals to fit.
      let goalMult = 1.0;
      if (p.expGoals >= MIN_XG_FOR_GOAL_PRIOR[pos] && med.conv > 0) {
        const goalLogResid = Math.log(p.conv) - Math.log(med.conv);
        goalMult = clamp(Math.exp(goalLogResid * w), MULT_CLAMP_LO, MULT_CLAMP_HI);
      }
      // Assist mult — only if the player has enough expected assists.
      let assistMult = 1.0;
      if (p.expAssists >= MIN_XA_FOR_ASSIST_PRIOR && med.assistConv > 0) {
        const assistLogResid = Math.log(p.assistConv) - Math.log(med.assistConv);
        assistMult = clamp(Math.exp(assistLogResid * w), MULT_CLAMP_LO, MULT_CLAMP_HI);
      }
      // Bonus mult — needs a season's worth of bonus history.
      let bonusMult = 1.0;
      if (p.seasonBonus >= MIN_BONUS_FOR_BONUS_PRIOR && med.bonus90 > 0) {
        const bonusLogResid = Math.log(Math.max(0.05, p.bonus90)) - Math.log(med.bonus90);
        bonusMult = clamp(Math.exp(bonusLogResid * w), MULT_CLAMP_LO, MULT_CLAMP_HI);
      }

      // Skip persistence entirely if we have nothing meaningful to say.
      if (goalMult === 1.0 && assistMult === 1.0 && bonusMult === 1.0) continue;

      const conf = Math.min(1, sample90s / 30);
      updates.push({
        player_id: p.player_id,
        web_name:  meta.get(p.player_id)?.web_name ?? '',
        goal_mult: goalMult, assist_mult: assistMult, bonus_mult: bonusMult,
        sample90s, conf
      });
    }
  }

  // Persist in chunks.
  const CHUNK = 100;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    await sql`
      INSERT INTO player_priors ${sql(slice.map(u => ({
        player_id: u.player_id,
        goal_conversion_mult: Number(u.goal_mult.toFixed(3)),
        assist_conversion_mult: Number(u.assist_mult.toFixed(3)),
        bonus_per_90_mult: Number(u.bonus_mult.toFixed(3)),
        sample_90s: Number(u.sample90s.toFixed(2)),
        confidence: Number(u.conf.toFixed(3))
      })) as any, 'player_id', 'goal_conversion_mult', 'assist_conversion_mult',
        'bonus_per_90_mult', 'sample_90s', 'confidence')}
      ON CONFLICT (player_id) DO UPDATE SET
        goal_conversion_mult   = EXCLUDED.goal_conversion_mult,
        assist_conversion_mult = EXCLUDED.assist_conversion_mult,
        bonus_per_90_mult      = EXCLUDED.bonus_per_90_mult,
        sample_90s             = EXCLUDED.sample_90s,
        confidence             = EXCLUDED.confidence,
        computed_at            = now()
    `;
  }

  // Top movers — for logging visibility.
  const top = updates
    .slice()
    .sort((a, b) => Math.abs(b.goal_mult - 1) - Math.abs(a.goal_mult - 1))
    .slice(0, 10)
    .map(u => ({
      web_name: u.web_name,
      goal_mult: u.goal_mult,
      bonus_mult: u.bonus_mult,
      sample90s: u.sample90s
    }));

  return { computed: updates.length, highMultipliers: top };
}

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return 1.0;
  return Math.max(lo, Math.min(hi, x));
}
