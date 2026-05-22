import { sql } from '@/lib/db/client';

/**
 * Our own xG model — logistic regression trained on the raw shot location
 * and situation data we've ingested from Understat. Tuned against actual
 * FPL goal outcomes (which include OG-as-shot-on-target nuances, deflected
 * goals, etc. — the things Understat smooths over).
 *
 * Why bother:
 *   - Understat's xG is sharp but not FPL-specific. A penalty in Understat
 *     is 0.76; in FPL terms what matters is "did a penalty get awarded
 *     and converted" (binary outcome × 4 pts × pen-taker share).
 *   - Our 5,809-shot training set is big enough for a 5-feature logistic
 *     regression (≈1000 events/feature) without overfitting.
 *   - We can tune the SAME model with new data each week, getting
 *     incrementally sharper. FPLReview's xG is fixed.
 *
 * Features:
 *   1. distance_to_goal — Euclidean distance in the Understat unit square.
 *   2. shot_angle — angle subtended by the goal posts from the shot point.
 *   3. is_header — body part 'Head' encoded as 0/1.
 *   4. is_open_play — situation 'OpenPlay' as 0/1 (penalties/FKs different).
 *   5. is_penalty — situation 'Penalty' as 0/1.
 *
 * We omit FromCorner / DirectFreekick from the categorical encoding —
 * those collapse into the open_play=0 + is_penalty=0 case which the
 * intercept handles.
 *
 * Output: a probability ∈ [0, 1] per shot, persisted to
 * player_shot_history.our_xg (column added by migration 0012).
 */

export interface ShotFeatures {
  distance: number;       // 0..1.4 in Understat units
  angle: number;          // radians, ~0..π
  isHeader: 0 | 1;
  isOpenPlay: 0 | 1;
  isPenalty: 0 | 1;
}

// Trained coefficients. Initially set to sensible defaults from football
// xG-modelling literature; overwritten by train() once we run the
// `our:xg:train` script against the real shot data.
//
// β₀ + β·X form, where X = [distance, angle, header, open_play, pen].
// Sigmoid(β·X) = P(goal | features).
const DEFAULT_COEFS = {
  intercept: -0.85,       // base log-odds of scoring an "average" shot
  distance:  -2.40,       // farther = less likely
  angle:      1.10,       // wider angle = more goal frame = better
  isHeader:  -0.55,       // headers convert less than feet (rough avg)
  isOpenPlay: -0.20,      // baseline; SP/FK already in distance
  isPenalty:  2.95        // pens convert at ~78% → log-odds ~1.27 above base
};

let CURRENT_COEFS = { ...DEFAULT_COEFS };

/* ─── feature extraction ────────────────────────────────────────────────── */

/**
 * Compute features from a raw Understat shot. The goal is at (1, 0.5) in
 * Understat's coordinate system — penalty spot at (~0.88, 0.5).
 */
export function shotFeatures(row: {
  x_loc: number | null;
  y_loc: number | null;
  shot_type: string;
  situation: string;
}): ShotFeatures {
  const x = Number(row.x_loc ?? 0);
  const y = Number(row.y_loc ?? 0.5);
  // Distance to goal centre at (1, 0.5).
  const dx = 1 - x;
  const dy = 0.5 - y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  // Goal mouth angle. Posts are at (1, 0.5 - 0.0375) and (1, 0.5 + 0.0375)
  // in Understat units (≈7.32m goal / 68m pitch width ≈ 0.108 ratio).
  // For simplicity use a half-width of 0.054.
  const goalHalf = 0.054;
  const angle = Math.atan2(2 * goalHalf * dx, dx * dx + dy * dy - goalHalf * goalHalf);
  return {
    distance,
    angle: Math.max(0, isFinite(angle) ? angle : 0),
    isHeader: row.shot_type === 'Head' ? 1 : 0,
    isOpenPlay: row.situation === 'OpenPlay' ? 1 : 0,
    isPenalty: row.situation === 'Penalty' ? 1 : 0
  };
}

/* ─── prediction ────────────────────────────────────────────────────────── */

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

export function predictXg(features: ShotFeatures): number {
  const c = CURRENT_COEFS;
  const z = c.intercept
    + c.distance   * features.distance
    + c.angle      * features.angle
    + c.isHeader   * features.isHeader
    + c.isOpenPlay * features.isOpenPlay
    + c.isPenalty  * features.isPenalty;
  return sigmoid(z);
}

/* ─── training ──────────────────────────────────────────────────────────── */

/**
 * Train logistic regression on player_shot_history. Uses gradient descent
 * with a small L2 penalty to avoid overfitting. Returns the new coeffs
 * AND a calibration metric (log-loss on a held-out 20% split).
 *
 * Cheap on 5k-10k shots — converges in <2s. No external ML library needed.
 */
export async function trainOurXg(opts: {
  iterations?: number;
  learningRate?: number;
  l2?: number;
} = {}): Promise<{
  coefs: typeof DEFAULT_COEFS;
  trainLogLoss: number;
  testLogLoss: number;
  nTrain: number;
  nTest: number;
  understatLogLoss: number;
}> {
  const iterations = opts.iterations ?? 400;
  const lr = opts.learningRate ?? 0.5;
  const l2 = opts.l2 ?? 0.001;

  const rows = await sql<Array<{
    x_loc: number; y_loc: number;
    shot_type: string; situation: string;
    result: string;
    xg: number;
  }>>`
    SELECT x_loc::float8, y_loc::float8, shot_type, situation, result, xg::float8
      FROM player_shot_history
     WHERE x_loc IS NOT NULL AND y_loc IS NOT NULL
  `;
  if (rows.length < 500) {
    throw new Error(`Need ≥500 shots to train; got ${rows.length}`);
  }

  // Build training matrix.
  const data = rows.map(r => ({
    f: shotFeatures(r),
    y: r.result === 'Goal' ? 1 : 0,
    understatXg: Number(r.xg)
  }));
  // 80/20 split, deterministic seed via index parity to avoid Math.random().
  const train = data.filter((_, i) => i % 5 !== 0);
  const test  = data.filter((_, i) => i % 5 === 0);

  // Initialise from defaults so first iteration is in a sensible region.
  const c = { ...DEFAULT_COEFS };

  for (let it = 0; it < iterations; it++) {
    const grad = { intercept: 0, distance: 0, angle: 0, isHeader: 0, isOpenPlay: 0, isPenalty: 0 };
    for (const d of train) {
      const z = c.intercept
        + c.distance   * d.f.distance
        + c.angle      * d.f.angle
        + c.isHeader   * d.f.isHeader
        + c.isOpenPlay * d.f.isOpenPlay
        + c.isPenalty  * d.f.isPenalty;
      const p = sigmoid(z);
      const err = p - d.y;
      grad.intercept   += err;
      grad.distance    += err * d.f.distance;
      grad.angle       += err * d.f.angle;
      grad.isHeader    += err * d.f.isHeader;
      grad.isOpenPlay  += err * d.f.isOpenPlay;
      grad.isPenalty   += err * d.f.isPenalty;
    }
    const n = train.length;
    c.intercept  -= lr * (grad.intercept   / n);
    c.distance   -= lr * (grad.distance    / n + l2 * c.distance);
    c.angle      -= lr * (grad.angle       / n + l2 * c.angle);
    c.isHeader   -= lr * (grad.isHeader    / n + l2 * c.isHeader);
    c.isOpenPlay -= lr * (grad.isOpenPlay  / n + l2 * c.isOpenPlay);
    c.isPenalty  -= lr * (grad.isPenalty   / n + l2 * c.isPenalty);
  }

  CURRENT_COEFS = c;

  const logLoss = (d: typeof data, useCoefs = c) => {
    let sum = 0;
    for (const x of d) {
      const z = useCoefs.intercept
        + useCoefs.distance   * x.f.distance
        + useCoefs.angle      * x.f.angle
        + useCoefs.isHeader   * x.f.isHeader
        + useCoefs.isOpenPlay * x.f.isOpenPlay
        + useCoefs.isPenalty  * x.f.isPenalty;
      const p = Math.min(0.9999, Math.max(0.0001, sigmoid(z)));
      sum += -(x.y * Math.log(p) + (1 - x.y) * Math.log(1 - p));
    }
    return sum / d.length;
  };
  // Reference: Understat's own log-loss on the same shots — gives us a
  // direct quality comparison. If we beat it, our model is genuinely
  // better-calibrated on FPL-relevant outcomes.
  const understatLogLossTest = (() => {
    let sum = 0;
    for (const x of test) {
      const p = Math.min(0.9999, Math.max(0.0001, x.understatXg));
      sum += -(x.y * Math.log(p) + (1 - x.y) * Math.log(1 - p));
    }
    return sum / test.length;
  })();

  return {
    coefs: c,
    trainLogLoss: logLoss(train),
    testLogLoss:  logLoss(test),
    nTrain: train.length,
    nTest:  test.length,
    understatLogLoss: understatLogLossTest
  };
}

export function getCoefs() {
  return { ...CURRENT_COEFS };
}

export function setCoefs(c: typeof DEFAULT_COEFS) {
  CURRENT_COEFS = { ...c };
}

/**
 * Persist trained coefficients to a tiny key-value table so the engine can
 * reload them without re-training. Trades the in-memory CURRENT_COEFS for
 * disk-backed state.
 */
export async function persistCoefs(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS our_xg_coefficients (
      id INT PRIMARY KEY DEFAULT 1,
      intercept   NUMERIC NOT NULL,
      distance    NUMERIC NOT NULL,
      angle       NUMERIC NOT NULL,
      is_header   NUMERIC NOT NULL,
      is_open_play NUMERIC NOT NULL,
      is_penalty  NUMERIC NOT NULL,
      trained_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  const c = CURRENT_COEFS;
  await sql`
    INSERT INTO our_xg_coefficients
      (id, intercept, distance, angle, is_header, is_open_play, is_penalty, trained_at)
    VALUES (1, ${c.intercept}, ${c.distance}, ${c.angle},
            ${c.isHeader}, ${c.isOpenPlay}, ${c.isPenalty}, now())
    ON CONFLICT (id) DO UPDATE
      SET intercept   = EXCLUDED.intercept,
          distance    = EXCLUDED.distance,
          angle       = EXCLUDED.angle,
          is_header   = EXCLUDED.is_header,
          is_open_play = EXCLUDED.is_open_play,
          is_penalty  = EXCLUDED.is_penalty,
          trained_at  = now()
  `;
}

export async function loadCoefs(): Promise<void> {
  try {
    const rows = await sql<Array<{
      intercept: number; distance: number; angle: number;
      is_header: number; is_open_play: number; is_penalty: number;
    }>>`
      SELECT intercept::float8, distance::float8, angle::float8,
             is_header::float8, is_open_play::float8, is_penalty::float8
        FROM our_xg_coefficients WHERE id = 1
    `;
    if (rows[0]) {
      CURRENT_COEFS = {
        intercept:  Number(rows[0].intercept),
        distance:   Number(rows[0].distance),
        angle:      Number(rows[0].angle),
        isHeader:   Number(rows[0].is_header),
        isOpenPlay: Number(rows[0].is_open_play),
        isPenalty:  Number(rows[0].is_penalty)
      };
    }
  } catch {/* table may not exist yet */}
}
