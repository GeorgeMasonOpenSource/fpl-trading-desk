import { sql } from '@/lib/db/client';

/**
 * Position-specific minutes calibration.
 *
 * Forwards get subbed off ~70 mins regularly; centre-backs play 90 most
 * weeks. Our minutes engine writes one number per player, but the
 * STRUCTURAL bias differs by position. By comparing predicted vs actual
 * minutes per position across finished GWs, we derive a per-position
 * scale factor to apply to expected_minutes when displaying.
 *
 * Note this is symmetric to model_calibration (xPts) — same shape, same
 * confidence-weighted approach. Could have lived in one table but kept
 * separate for clarity in what corrects what.
 */

export interface MinutesCalibration {
  position: 'GKP'|'DEF'|'MID'|'FWD';
  meanPredicted: number;
  meanActual: number;
  multiplier: number;       // clamped 0.85..1.10
  confidence: number;       // 0..1, scales with sample size
  sampleN: number;
}

/**
 * Recompute per-position minutes multipliers from finished GWs.
 *
 * Writes to a minutes_calibration table (created lazily if absent).
 */
export async function recomputeMinutesCalibration(): Promise<MinutesCalibration[]> {
  await sql`
    CREATE TABLE IF NOT EXISTS minutes_calibration (
      position           TEXT PRIMARY KEY,
      mean_predicted     NUMERIC(6,2) NOT NULL DEFAULT 0,
      mean_actual        NUMERIC(6,2) NOT NULL DEFAULT 0,
      multiplier         NUMERIC(5,3) NOT NULL DEFAULT 1.0,
      confidence         NUMERIC(4,3) NOT NULL DEFAULT 0,
      sample_n           INT NOT NULL DEFAULT 0,
      last_recomputed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  const rows = await sql<Array<{
    position: 'GKP'|'DEF'|'MID'|'FWD';
    mean_predicted: number;
    mean_actual: number;
    n: number;
  }>>`
    WITH paired AS (
      SELECT p.position,
             mn.expected_minutes::float8 AS predicted,
             pgh.minutes::float8         AS actual
        FROM minutes_projections mn
        JOIN players p ON p.id = mn.player_id
        JOIN player_gameweek_history pgh
          ON pgh.player_id = mn.player_id
         AND pgh.fixture_id = mn.fixture_id
        JOIN fixtures f ON f.id = mn.fixture_id
       WHERE f.finished = TRUE
         AND pgh.minutes IS NOT NULL
         AND mn.expected_minutes > 0
    )
    SELECT position,
           AVG(predicted)::float8 AS mean_predicted,
           AVG(actual)::float8    AS mean_actual,
           COUNT(*)::int          AS n
      FROM paired
     GROUP BY position
     ORDER BY position
  `;

  const out: MinutesCalibration[] = [];
  for (const r of rows) {
    const meanPred = Number(r.mean_predicted) || 1;
    const meanAct  = Number(r.mean_actual)    || 1;
    const rawMult  = meanAct / meanPred;
    // Tight clamp — minutes shouldn't be re-scaled aggressively. ±10%.
    const multiplier = Math.max(0.85, Math.min(1.10, rawMult));
    const confidence = Math.max(0, Math.min(1, Number(r.n) / 1200));
    await sql`
      INSERT INTO minutes_calibration
        (position, mean_predicted, mean_actual, multiplier, confidence, sample_n, last_recomputed_at)
      VALUES (${r.position}, ${meanPred}, ${meanAct}, ${multiplier}, ${confidence}, ${r.n}, now())
      ON CONFLICT (position) DO UPDATE
        SET mean_predicted = EXCLUDED.mean_predicted,
            mean_actual    = EXCLUDED.mean_actual,
            multiplier     = EXCLUDED.multiplier,
            confidence     = EXCLUDED.confidence,
            sample_n       = EXCLUDED.sample_n,
            last_recomputed_at = now()
    `;
    out.push({
      position: r.position,
      meanPredicted: meanPred,
      meanActual: meanAct,
      multiplier,
      confidence,
      sampleN: Number(r.n)
    });
  }
  return out;
}

export async function loadMinutesCalibration(): Promise<Map<string, MinutesCalibration>> {
  const out = new Map<string, MinutesCalibration>();
  try {
    const rows = await sql<Array<{
      position: 'GKP'|'DEF'|'MID'|'FWD';
      mean_predicted: number; mean_actual: number;
      multiplier: number; confidence: number; sample_n: number;
    }>>`
      SELECT position, mean_predicted::float8, mean_actual::float8,
             multiplier::float8, confidence::float8, sample_n
        FROM minutes_calibration
    `;
    for (const r of rows) {
      out.set(r.position, {
        position: r.position,
        meanPredicted: Number(r.mean_predicted),
        meanActual: Number(r.mean_actual),
        multiplier: Number(r.multiplier),
        confidence: Number(r.confidence),
        sampleN: Number(r.sample_n)
      });
    }
  } catch {/* table may not exist yet */}
  return out;
}

/** Apply the multiplier to a raw expected_minutes value, confidence-weighted. */
export function applyMinutesCalibration(
  position: 'GKP'|'DEF'|'MID'|'FWD',
  rawMinutes: number,
  calibrationByPosition: Map<string, MinutesCalibration>
): number {
  const cal = calibrationByPosition.get(position);
  if (!cal) return rawMinutes;
  const effectiveMult = (1 - cal.confidence) * 1.0 + cal.confidence * cal.multiplier;
  return Math.max(0, Math.min(90, rawMinutes * effectiveMult));
}
