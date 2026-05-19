// Tiny deterministic numeric helpers. No external math libs.

export const clamp = (x: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, x));

export const clamp01 = (x: number) => clamp(x, 0, 1);

/** Logistic curve, capped so we never produce 0 or 1 exactly. */
export function logistic(x: number): number {
  const e = Math.exp(-x);
  const y = 1 / (1 + e);
  return clamp(y, 1e-4, 1 - 1e-4);
}

/** Poisson probability mass — used for goal distribution simulation. */
export function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  // log-space for numerical safety on slightly larger lambdas.
  let logp = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logp -= Math.log(i);
  return Math.exp(logp);
}

/** P(X >= 1) for a Poisson(lambda). Used for goal/assist points. */
export function poissonAtLeastOne(lambda: number): number {
  return 1 - Math.exp(-lambda);
}

/** Weighted mean. Skips entries with weight <= 0. */
export function weightedMean(values: Array<{ value: number; weight: number }>): number {
  let num = 0;
  let den = 0;
  for (const { value, weight } of values) {
    if (weight <= 0 || !Number.isFinite(value)) continue;
    num += value * weight;
    den += weight;
  }
  return den === 0 ? 0 : num / den;
}

/** Shrink a sample-based estimate toward a prior using equivalent-sample-size logic. */
export function shrink(sampleMean: number, sampleN: number, priorMean: number, priorN: number): number {
  if (sampleN <= 0 && priorN <= 0) return 0;
  return (sampleMean * sampleN + priorMean * priorN) / (sampleN + priorN);
}
