/**
 * Calibration layer — applied AFTER the projection engine writes raw xPts.
 *
 * Two corrections:
 *   1. Position-level multiplier from model_calibration. Self-corrects
 *      systematic bias (e.g. "model under-rates forwards by 15%") using
 *      last-GW snapshot vs actuals.
 *   2. Per-player manual benchmark blend from player_benchmark_overrides.
 *      Lets the user paste FPLReview / Fanteam / etc. xPts and blend it
 *      with our number at a configurable weight. Hard override for cases
 *      where we know the model is off.
 *
 * Used by every page that displays xPts to the user. The engine itself
 * still writes raw values to `projections.xpts_total` — calibration is a
 * read-layer transform so the audit trail stays intact (model-audit shows
 * raw, dashboard shows calibrated).
 */
import { sql } from '@/lib/db/client';
import { loadCreatorConsensus, type CreatorConsensusScore } from './creator-consensus';

export interface CalibratedXpts {
  raw: number;
  calibrated: number;
  positionMultiplier: number;
  positionConfidence: number;
  benchmarkXpts: number | null;
  benchmarkSource: string | null;
  benchmarkWeight: number;
  // §creator-consensus — additive xPts adjustment from YouTube creator
  // consensus (FPL Harry/Focal/Mate buy/sell/captain signals).
  // Documented in lib/projections/creator-consensus.ts.
  consensusAdjustment: number;
  consensusReason: string;
}

/**
 * Apply calibration to a single (player, gw) projection. Cheap — uses
 * pre-loaded maps, no extra SQL per call.
 */
export function calibrateOne(opts: {
  rawXpts: number;
  playerId: number;
  position: 'GKP'|'DEF'|'MID'|'FWD';
  calibrationByPosition: Map<string, { multiplier: number; confidence: number }>;
  benchmarkForPlayer?: { benchmark_xpts: number; blend_weight: number; source: string };
  consensusForPlayer?: CreatorConsensusScore;
}): CalibratedXpts {
  const cal = opts.calibrationByPosition.get(opts.position);
  const positionMultiplier = cal?.multiplier ?? 1.0;
  const positionConfidence = cal?.confidence ?? 0.0;

  // §position-correction — apply confidence-weighted multiplier.
  // confidence=0 → no correction. confidence=1 → full multiplier.
  const effectiveMult = (1 - positionConfidence) * 1.0 + positionConfidence * positionMultiplier;
  let calibrated = opts.rawXpts * effectiveMult;

  // §creator-consensus — add the (signed) creator-consensus adjustment.
  // Capped at ±0.8 inside loadCreatorConsensus so it nudges, not overrides.
  const consensusAdjustment = opts.consensusForPlayer?.xptsAdjustment ?? 0;
  calibrated += consensusAdjustment;

  // §benchmark-blend — if a manual benchmark exists, mix it in.
  if (opts.benchmarkForPlayer) {
    const w = Math.max(0, Math.min(1, opts.benchmarkForPlayer.blend_weight));
    calibrated = (1 - w) * calibrated + w * opts.benchmarkForPlayer.benchmark_xpts;
  }

  return {
    raw: opts.rawXpts,
    calibrated,
    positionMultiplier,
    positionConfidence,
    benchmarkXpts: opts.benchmarkForPlayer?.benchmark_xpts ?? null,
    benchmarkSource: opts.benchmarkForPlayer?.source ?? null,
    benchmarkWeight: opts.benchmarkForPlayer?.blend_weight ?? 0,
    consensusAdjustment,
    consensusReason: opts.consensusForPlayer?.reason ?? ''
  };
}

/** Pre-load all calibration data for a gameweek. */
export async function loadCalibrationContext(gameweekId: number): Promise<{
  calibrationByPosition: Map<string, { multiplier: number; confidence: number }>;
  benchmarksByPlayer: Map<number, { benchmark_xpts: number; blend_weight: number; source: string }>;
  consensusByPlayer: Map<number, CreatorConsensusScore>;
}> {
  const calibrationByPosition = new Map<string, { multiplier: number; confidence: number }>();
  try {
    const rows = await sql<Array<{
      position: string; multiplier: number; confidence: number;
    }>>`
      SELECT position, multiplier::float8, confidence::float8
        FROM model_calibration
    `;
    for (const r of rows) {
      calibrationByPosition.set(r.position, {
        multiplier: Number(r.multiplier),
        confidence: Number(r.confidence)
      });
    }
  } catch {/* table may not exist before migration 0010 applied */}

  const benchmarksByPlayer = new Map<number, { benchmark_xpts: number; blend_weight: number; source: string }>();
  try {
    const rows = await sql<Array<{
      player_id: number; benchmark_xpts: number; blend_weight: number; source: string;
    }>>`
      SELECT player_id, benchmark_xpts::float8, blend_weight::float8, source
        FROM player_benchmark_overrides
       WHERE gameweek_id = ${gameweekId}
    `;
    // If multiple sources exist for a player, average them with their weights.
    const aggBySource = new Map<number, Array<{ benchmark_xpts: number; blend_weight: number; source: string }>>();
    for (const r of rows) {
      const arr = aggBySource.get(r.player_id) ?? [];
      arr.push({
        benchmark_xpts: Number(r.benchmark_xpts),
        blend_weight: Number(r.blend_weight),
        source: r.source
      });
      aggBySource.set(r.player_id, arr);
    }
    for (const [playerId, entries] of aggBySource) {
      // Average the benchmarks, average the weights, keep the source as
      // a comma-joined string for transparency.
      const avgXpts = entries.reduce((s, e) => s + e.benchmark_xpts, 0) / entries.length;
      const avgWeight = entries.reduce((s, e) => s + e.blend_weight, 0) / entries.length;
      const sources = Array.from(new Set(entries.map(e => e.source))).join(', ');
      benchmarksByPlayer.set(playerId, {
        benchmark_xpts: avgXpts,
        blend_weight: avgWeight,
        source: sources
      });
    }
  } catch {/* */}

  // §creator-consensus — pull the last-7-day signal aggregation.
  let consensusByPlayer: Map<number, CreatorConsensusScore> = new Map();
  try {
    consensusByPlayer = await loadCreatorConsensus(7);
  } catch {/* tables may not exist (transcripts not ingested) */}

  return { calibrationByPosition, benchmarksByPlayer, consensusByPlayer };
}
