/**
 * Null-safe formatters for the UI. Anything coming from Postgres can in theory
 * be null (LEFT JOINs, missing rows, SUM-of-empty-set), and calling .toFixed
 * on null is the #1 crash source in the dashboard.
 */
export function n(v: unknown, fallback = 0): number {
  if (v == null) return fallback;
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

export function fmt(v: unknown, digits = 2): string {
  return n(v).toFixed(digits);
}

export function pct(v: unknown, digits = 0): string {
  return (n(v) * 100).toFixed(digits) + '%';
}
