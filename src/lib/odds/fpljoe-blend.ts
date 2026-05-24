/**
 * FPL Joe odds → engine blend.
 *
 * Loads the latest per-fixture lambdas from `fpljoe_odds` and exposes a
 * helper that returns, for each (team, fixture), a market-derived
 * expected-goals-FOR and expected-goals-AGAINST.
 *
 * Usage in the projection engine: blend market lambdas with our own
 * model-derived team xG. Default blend = 0.4 × market + 0.6 × model
 * when the market has high confidence; falls back to model-only when
 * fpljoe_odds is empty / stale / low-confidence.
 *
 * Why blend rather than replace: the market knows lineup leaks and late
 * injury news; our model knows the structural team-strength layer. The
 * blend captures both without the engine becoming a thin bookmaker
 * wrapper.
 */
import { sql } from '@/lib/db/client';

export interface MarketLambdas {
  /** Expected goals FOR this team in this fixture. */
  xgFor: number;
  /** Expected goals AGAINST this team in this fixture. */
  xgAgainst: number;
  /** Market confidence 0..1 — multiplier for the blend weight. */
  confidence: number;
  /** Snapshot timestamp. Stale > 6h → callers can downweight. */
  snapshotTs: string;
  /** 24h movement on xgFor (current - 24h ago). Positive = market
   *  thinks the team is stronger than yesterday. */
  movement24hFor: number | null;
  movement24hAgainst: number | null;
}

/**
 * Pull all fpljoe_odds rows for a gameweek and key them by (team_id,
 * fixture_id) so the projection engine can look them up.
 */
export async function loadMarketLambdasForGw(gameweekId: number): Promise<Map<string, MarketLambdas>> {
  const m = new Map<string, MarketLambdas>();
  try {
    type Row = {
      fixture_id: number; team_h: number; team_a: number;
      lambda_home: number; lambda_away: number;
      lambda_home_24h: number | null; lambda_away_24h: number | null;
      confidence: number; snapshot_ts: string;
    };
    const rows = await sql<Row[]>`
      SELECT o.fixture_id, f.team_h, f.team_a,
             o.lambda_home::float, o.lambda_away::float,
             o.lambda_home_24h::float, o.lambda_away_24h::float,
             o.confidence::float, o.snapshot_ts::text AS snapshot_ts
      FROM fpljoe_odds o
      JOIN fixtures f ON f.id = o.fixture_id
      WHERE f.gameweek_id = ${gameweekId}
    `;
    for (const r of rows) {
      const conf = Number(r.confidence);
      const ts   = r.snapshot_ts;
      // Home team perspective: scores lambda_home, concedes lambda_away.
      m.set(`${r.team_h}|${r.fixture_id}`, {
        xgFor:     Number(r.lambda_home),
        xgAgainst: Number(r.lambda_away),
        confidence: conf,
        snapshotTs: ts,
        movement24hFor:     r.lambda_home_24h != null ? Number(r.lambda_home) - Number(r.lambda_home_24h) : null,
        movement24hAgainst: r.lambda_away_24h != null ? Number(r.lambda_away) - Number(r.lambda_away_24h) : null,
      });
      // Away team perspective: scores lambda_away, concedes lambda_home.
      m.set(`${r.team_a}|${r.fixture_id}`, {
        xgFor:     Number(r.lambda_away),
        xgAgainst: Number(r.lambda_home),
        confidence: conf,
        snapshotTs: ts,
        movement24hFor:     r.lambda_away_24h != null ? Number(r.lambda_away) - Number(r.lambda_away_24h) : null,
        movement24hAgainst: r.lambda_home_24h != null ? Number(r.lambda_home) - Number(r.lambda_home_24h) : null,
      });
    }
  } catch (err) {
    // Table missing (migration not yet applied) — return empty map.
    console.warn(`[fpljoe-blend] skipped: ${(err as Error).message}`);
  }
  return m;
}

/**
 * Blend market xgFor with the model's own xgFor. Returns the model
 * value untouched when the market signal is missing or stale.
 *
 * Blend weight is bounded: even at max market confidence we keep 50%
 * of the model so we never become a pure bookmaker wrapper. The market
 * is one signal among many, not the ground truth.
 */
export function blendLambda(
  modelLambda: number,
  market: MarketLambdas | undefined,
  opts: { maxWeight?: number; maxAgeHours?: number } = {}
): { value: number; weight: number; source: 'blend' | 'model_only' | 'market_only' } {
  const maxWeight   = opts.maxWeight   ?? 0.40;
  const maxAgeHours = opts.maxAgeHours ?? 24;
  if (!market) return { value: modelLambda, weight: 0, source: 'model_only' };
  const ts = Date.parse(market.snapshotTs);
  const ageH = Number.isFinite(ts) ? (Date.now() - ts) / 3_600_000 : Infinity;
  if (ageH > maxAgeHours) return { value: modelLambda, weight: 0, source: 'model_only' };
  // Confidence × age decay: a 6h-old snapshot at 0.9 confidence carries
  // ~0.85 of its market weight.
  const ageDecay = Math.max(0, 1 - ageH / maxAgeHours);
  const w = Math.max(0, Math.min(maxWeight, maxWeight * market.confidence * ageDecay));
  const value = w * market.xgFor + (1 - w) * modelLambda;
  return { value, weight: w, source: 'blend' };
}
