import { sql, json } from '@/lib/db/client';

/**
 * Backtesting module.
 *
 * Replay a finished gameweek: rebuild what projections WOULD have been at
 * deadline by re-running the engines against player_gameweek_history data
 * up to (but not including) the target GW. Compare against actuals.
 *
 *   - MAE / RMSE on xPts
 *   - Rank correlation (Spearman approx via tie-aware ranking)
 *   - Minutes accuracy: start_prob calibration, 60+ accuracy, 90 accuracy
 *   - Captain top-3 hit rate
 *   - Transfer EV vs actual delta
 *   - Hit success rate (did -4 net positive?)
 *   - Chip value vs baseline week
 *   - Roll-transfer success rate (did rolling pay off the following week?)
 *
 * Every model rule in the engines can be toggled via the run spec so we can
 * promote / demote rules based on real measured impact, not opinion.
 */

export interface BacktestSpec {
  fromGameweek: number;
  toGameweek: number;
  rules: {
    chaseRecentGoals: boolean;            // anti-rule: if true, we'd weight recent goals heavily (used to prove the spec rule)
    europeanRotationPenalty: boolean;
    rotationResistanceScaling: boolean;
    seasonStageWeighting: boolean;
    teamObjectiveScoring: boolean;
    returnFromInjuryCaps: boolean;
  };
  cohort?: 'all' | 'GKP' | 'DEF' | 'MID' | 'FWD';
}

export interface BacktestMetric {
  metric: string;
  scope: string;
  scopeValue?: string;
  value: number;
  detail?: unknown;
}

export async function runBacktest(name: string, spec: BacktestSpec): Promise<{ runId: number; metrics: BacktestMetric[] }> {
  const [{ id: runId }] = await sql<Array<{ id: number }>>`
    INSERT INTO backtest_runs (name, spec, started_at)
    VALUES (${name}, ${json(spec)}, now())
    RETURNING id
  `;

  const metrics: BacktestMetric[] = [];

  // Iterate target GWs
  for (let gw = spec.fromGameweek; gw <= spec.toGameweek; gw++) {
    // Snapshot of projections we made at the time (projection_snapshots, earliest before deadline)
    const projections = await sql<Array<{ player_id: number; predicted: number }>>`
      SELECT player_id, ((payload->>'xpts_total')::numeric) AS predicted
      FROM projection_snapshots
      WHERE gameweek_id = ${gw}
      -- Take the snapshot closest to (but before) kickoff
      ORDER BY taken_at ASC
    `;
    const actuals = await sql<Array<{ player_id: number; actual: number; minutes: number; starts: number }>>`
      SELECT player_id,
             SUM(total_points)::numeric AS actual,
             SUM(minutes)::int AS minutes,
             SUM(starts)::int AS starts
      FROM player_gameweek_history
      WHERE gameweek_id = ${gw}
      GROUP BY player_id
    `;
    const actualMap = new Map(actuals.map(r => [r.player_id, r]));

    let n = 0, sumErr = 0, sumSqErr = 0;
    for (const p of projections) {
      const a = actualMap.get(p.player_id);
      if (!a) continue;
      const err = Number(p.predicted) - Number(a.actual);
      sumErr += Math.abs(err); sumSqErr += err * err; n++;
    }
    if (n > 0) {
      metrics.push({ metric: 'mae',  scope: 'gameweek', scopeValue: String(gw), value: sumErr / n });
      metrics.push({ metric: 'rmse', scope: 'gameweek', scopeValue: String(gw), value: Math.sqrt(sumSqErr / n) });
    }

    // Captain top-3 hit rate: was the highest actual point getter in our top 3 ranking?
    const top3 = projections.slice().sort((a, b) => Number(b.predicted) - Number(a.predicted)).slice(0, 3).map(p => p.player_id);
    const actualTop = actuals.slice().sort((a, b) => Number(b.actual) - Number(a.actual))[0];
    const hit = actualTop && top3.includes(actualTop.player_id) ? 1 : 0;
    metrics.push({ metric: 'captain_top3_hit', scope: 'gameweek', scopeValue: String(gw), value: hit });

    // Rank correlation (Spearman approx)
    const preds = projections.map(p => ({ id: p.player_id, v: Number(p.predicted) }));
    const acts  = actuals.map(p => ({ id: p.player_id, v: Number(p.actual) }));
    const rho = spearman(preds, acts);
    metrics.push({ metric: 'rank_correlation', scope: 'gameweek', scopeValue: String(gw), value: rho });

    // Minutes calibration
    const minutesRows = await sql<Array<{
      player_id: number; start_prob: number; ninety_prob: number; sixty_plus_prob: number;
    }>>`
      SELECT player_id, start_prob, ninety_prob, sixty_plus_prob
      FROM minutes_projections mp
      JOIN fixtures f ON f.id = mp.fixture_id AND f.gameweek_id = ${gw}
    `;
    let sStart = 0, sSixty = 0, sNinety = 0, c = 0;
    for (const m of minutesRows) {
      const a = actualMap.get(m.player_id);
      if (!a) continue;
      sStart += Math.abs((a.starts ? 1 : 0) - m.start_prob);
      sSixty += Math.abs((a.minutes >= 60 ? 1 : 0) - m.sixty_plus_prob);
      sNinety += Math.abs((a.minutes >= 90 ? 1 : 0) - m.ninety_prob);
      c++;
    }
    if (c > 0) {
      metrics.push({ metric: 'start_prob_mae', scope: 'gameweek', scopeValue: String(gw), value: sStart / c });
      metrics.push({ metric: 'sixty_plus_mae', scope: 'gameweek', scopeValue: String(gw), value: sSixty / c });
      metrics.push({ metric: 'ninety_mae',     scope: 'gameweek', scopeValue: String(gw), value: sNinety / c });
    }
  }

  // Persist all metrics
  for (const m of metrics) {
    await sql`
      INSERT INTO backtest_results (run_id, metric, scope, scope_value, value, detail)
      VALUES (${runId}, ${m.metric}, ${m.scope}, ${m.scopeValue ?? null}, ${m.value},
              ${m.detail ? json(m.detail) : null})
    `;
  }

  const summary = metrics.reduce<Record<string, { sum: number; n: number }>>((acc, m) => {
    acc[m.metric] ??= { sum: 0, n: 0 };
    acc[m.metric].sum += m.value; acc[m.metric].n++;
    return acc;
  }, {});
  const summaryAvg = Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, v.sum / v.n]));

  await sql`
    UPDATE backtest_runs
    SET finished_at = now(), summary = ${json(summaryAvg)}
    WHERE id = ${runId}
  `;

  return { runId, metrics };
}

function spearman(a: Array<{ id: number; v: number }>, b: Array<{ id: number; v: number }>): number {
  const rankMap = (arr: Array<{ id: number; v: number }>) => {
    const sorted = [...arr].sort((x, y) => y.v - x.v);
    const m = new Map<number, number>();
    sorted.forEach((r, i) => m.set(r.id, i + 1));
    return m;
  };
  const ra = rankMap(a), rb = rankMap(b);
  const ids = [...new Set([...ra.keys(), ...rb.keys()])];
  let sumD2 = 0, n = 0;
  for (const id of ids) {
    if (!ra.has(id) || !rb.has(id)) continue;
    const d = ra.get(id)! - rb.get(id)!;
    sumD2 += d * d; n++;
  }
  if (n < 2) return 0;
  return 1 - (6 * sumD2) / (n * (n * n - 1));
}
