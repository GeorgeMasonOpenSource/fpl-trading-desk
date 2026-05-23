#!/usr/bin/env tsx
/**
 * FPLReview diff — sanity check our GW projections against the
 * established public benchmark.
 *
 * Usage:
 *   1. Save FPLReview's published GW projections as a CSV at
 *      data/fplreview-gw{N}.csv with columns:
 *         player,team,position,xpts
 *      (tab- or comma-separated; web_name match is fuzzy).
 *   2. Run:
 *         npm run fplreview:diff -- --gw=38
 *
 * Output:
 *   - Top-20 biggest disagreements (positive = us higher than FPLReview,
 *     negative = us lower). For each, dumps the engine inputs that most
 *     plausibly explain the gap (minutes, defcon, pen share, set-piece
 *     role, recency form, team_xg_for) so we can decide whether OUR or
 *     THEIR number is more defensible.
 *   - Summary stats: bias (mean delta), MAE, RMSE by position.
 *
 * Why this exists:
 *   We don't have a real walk-forward yet so we can't measure RMSE
 *   against actuals. FPLReview is the next-best ground-truth proxy —
 *   they've spent years on calibration, so systematic divergence is a
 *   strong signal that one of our modules is mis-calibrated.
 *
 * Format expected (one of):
 *   - CSV: `player,team,position,xpts`
 *   - Tab-separated paste from FPLReview's web table:
 *     `Player\tTeam\tPos\txMin\txPts`
 *   - Their JSON dump if you can grab it.
 *
 * The parser is intentionally lenient — tries each format until one
 * works. Match-up to our players via web_name (Levenshtein-tolerant).
 */
import { readFileSync, existsSync } from 'node:fs';
import { sql } from '../src/lib/db/client';

interface Reference {
  webName: string;
  teamHint?: string;
  position?: string;
  xpts: number;
}

interface OurRow {
  player_id: number;
  web_name: string;
  team_short: string;
  position: string;
  xpts_total: number;
  xpts_appearance: number;
  xpts_goals: number;
  xpts_assists: number;
  xpts_clean_sheet: number;
  xpts_bonus: number;
  xpts_defcon: number;
  expected_minutes: number | null;
  start_prob: number | null;
  penalties_order: number | null;
  shots_penalty: number | null;
  season_defcon_per_90: number | null;
  team_xg_total: number | null;
}

function parseReference(raw: string): Reference[] {
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (lines.length === 0) return [];
  // Detect delimiter: tab > comma > whitespace
  const first = lines[0]!;
  const delim = first.includes('\t') ? '\t' : first.includes(',') ? ',' : /\s{2,}/;
  // Skip header if present
  const start = /player|name/i.test(first) ? 1 : 0;
  const rows: Reference[] = [];
  for (let i = start; i < lines.length; i++) {
    const parts = lines[i]!.split(delim as any).map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    // Heuristic: last numeric column is xpts; first text is player name.
    const xptsIdx = parts.length - 1;
    const xpts = Number(parts[xptsIdx]);
    if (!Number.isFinite(xpts)) continue;
    rows.push({
      webName: parts[0]!,
      teamHint: parts.length >= 4 ? parts[1] : undefined,
      position: parts.length >= 4 ? parts[2] : undefined,
      xpts
    });
  }
  return rows;
}

// Lightweight name matcher: lowercase, strip accents, exact substring first;
// fall back to token-overlap if no clean match.
function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '');
}

function matchPlayer(refName: string, ours: OurRow[]): OurRow | undefined {
  const target = norm(refName);
  // Exact web_name (case-insensitive) wins.
  const exact = ours.find(o => norm(o.web_name) === target);
  if (exact) return exact;
  // Substring either direction.
  const sub = ours.find(o => norm(o.web_name).includes(target) || target.includes(norm(o.web_name)));
  if (sub) return sub;
  // Token overlap (≥2 tokens match).
  const tokens = target.split(' ').filter(t => t.length >= 3);
  if (tokens.length === 0) return undefined;
  const scored = ours.map(o => {
    const onorm = norm(o.web_name);
    const hits = tokens.filter(t => onorm.includes(t)).length;
    return { o, hits };
  }).filter(s => s.hits >= 2).sort((a, b) => b.hits - a.hits);
  return scored[0]?.o;
}

async function loadOurProjections(gw: number): Promise<OurRow[]> {
  return await sql<OurRow[]>`
    SELECT pr.player_id, p.web_name, t.short_name AS team_short, p.position,
           SUM(pr.xpts_total)::float8     AS xpts_total,
           SUM(pr.xpts_appearance)::float8 AS xpts_appearance,
           SUM(pr.xpts_goals)::float8     AS xpts_goals,
           SUM(pr.xpts_assists)::float8   AS xpts_assists,
           SUM(pr.xpts_clean_sheet)::float8 AS xpts_clean_sheet,
           SUM(pr.xpts_bonus)::float8     AS xpts_bonus,
           SUM(pr.xpts_defcon)::float8    AS xpts_defcon,
           MAX(mn.expected_minutes)::float8 AS expected_minutes,
           MAX(mn.start_prob)::float8       AS start_prob,
           MAX(p.penalties_order)           AS penalties_order,
           MAX(psa.shots_penalty)           AS shots_penalty,
           MAX(p.season_defcon_per_90)::float8 AS season_defcon_per_90,
           MAX(p.team_xg_total)::float8      AS team_xg_total
      FROM projections pr
      JOIN players p ON p.id = pr.player_id
      JOIN teams   t ON t.id = p.team_id
      LEFT JOIN minutes_projections mn ON mn.player_id = p.id
        AND mn.fixture_id IN (SELECT id FROM fixtures WHERE gameweek_id = ${gw})
      LEFT JOIN player_shot_aggregates psa ON psa.player_id = p.id
     WHERE pr.gameweek_id = ${gw}
     GROUP BY pr.player_id, p.web_name, t.short_name, p.position
  `;
}

function explainGap(ours: OurRow, ref: Reference, delta: number): string[] {
  // Delta = ours - ref. Positive = we're higher.
  const out: string[] = [];
  if (ours.expected_minutes != null && ours.expected_minutes < 70) {
    out.push(`our mins=${ours.expected_minutes!.toFixed(0)} (start ${((ours.start_prob ?? 0)*100).toFixed(0)}%) — we may be over-rotating`);
  }
  if (ours.expected_minutes != null && ours.expected_minutes > 85 && delta > 1.0) {
    out.push(`our mins=${ours.expected_minutes!.toFixed(0)} — we treat as nailed starter; FPLReview may be more cautious`);
  }
  if (ours.penalties_order === 2 && (ours.shots_penalty ?? 0) < 5) {
    out.push(`#2 pen taker with only ${ours.shots_penalty ?? 0} actual pen shots — our pen-share inflation`);
  }
  if (ours.penalties_order === 1 && (ours.shots_penalty ?? 0) < 3) {
    out.push(`#1 pen taker with only ${ours.shots_penalty ?? 0} actual pen shots — insufficient sample`);
  }
  if ((ours.season_defcon_per_90 ?? 0) >= 8 && ours.xpts_defcon > 0.3) {
    out.push(`defcon ${ours.season_defcon_per_90?.toFixed(1)}/90 → ${ours.xpts_defcon.toFixed(2)} xPts — borderline reliability`);
  }
  if (ours.position === 'FWD' && (ours.team_xg_total ?? 0) < 1.0) {
    out.push(`team_xg_for=${ours.team_xg_total?.toFixed(2)} is low — weak attacking projection`);
  }
  if (out.length === 0) {
    out.push(`no obvious calibration issue — could be FPLReview using newer info (lineup, injury, manager hint)`);
  }
  return out;
}

async function main() {
  const gwArg = process.argv.find(a => a.startsWith('--gw='));
  const gw = gwArg ? Number(gwArg.split('=')[1]) : 38;
  const pathArg = process.argv.find(a => a.startsWith('--file='));
  const filePath = pathArg ? pathArg.split('=')[1]! : `data/fplreview-gw${gw}.csv`;

  if (!existsSync(filePath)) {
    console.error(`No reference file at ${filePath}.`);
    console.error(`\nCopy FPLReview's GW${gw} table to that path (tab- or comma-separated):`);
    console.error(`   player,team,position,xpts`);
    console.error(`   Salah,LIV,MID,7.2`);
    console.error(`   Haaland,MCI,FWD,6.9`);
    console.error(`   ...`);
    process.exit(1);
  }

  const raw = readFileSync(filePath, 'utf-8');
  const refs = parseReference(raw);
  if (refs.length === 0) {
    console.error(`No rows parsed from ${filePath} — check the format.`);
    process.exit(1);
  }
  console.log(`Loaded ${refs.length} reference rows from ${filePath}`);

  const ours = await loadOurProjections(gw);
  console.log(`Loaded ${ours.length} of our projections for GW${gw}`);

  // Match every reference row to one of ours.
  const matched: Array<{ ref: Reference; ours: OurRow; delta: number }> = [];
  const unmatched: Reference[] = [];
  for (const ref of refs) {
    const m = matchPlayer(ref.webName, ours);
    if (m) matched.push({ ref, ours: m, delta: m.xpts_total - ref.xpts });
    else unmatched.push(ref);
  }
  console.log(`Matched ${matched.length} (${unmatched.length} unmatched)`);
  if (unmatched.length > 0 && unmatched.length <= 8) {
    console.log(`  Unmatched: ${unmatched.map(r => r.webName).join(', ')}`);
  }

  // Summary stats.
  const n = matched.length;
  const bias = matched.reduce((s, m) => s + m.delta, 0) / n;
  const mae  = matched.reduce((s, m) => s + Math.abs(m.delta), 0) / n;
  const rmse = Math.sqrt(matched.reduce((s, m) => s + m.delta ** 2, 0) / n);
  console.log(`\nOverall vs FPLReview (n=${n})`);
  console.log(`  bias ${bias >= 0 ? '+' : ''}${bias.toFixed(3)}    mae ${mae.toFixed(3)}    rmse ${rmse.toFixed(3)}`);

  // By position.
  console.log(`\nBy position`);
  console.log(`  pos    n   bias    mae    rmse`);
  for (const pos of ['GKP', 'DEF', 'MID', 'FWD']) {
    const sub = matched.filter(m => m.ours.position === pos);
    if (sub.length === 0) { console.log(`  ${pos}     0    —      —      —`); continue; }
    const b = sub.reduce((s, m) => s + m.delta, 0) / sub.length;
    const a = sub.reduce((s, m) => s + Math.abs(m.delta), 0) / sub.length;
    const r = Math.sqrt(sub.reduce((s, m) => s + m.delta ** 2, 0) / sub.length);
    console.log(`  ${pos.padEnd(4)}  ${String(sub.length).padStart(3)}  ${b >= 0 ? '+' : ''}${b.toFixed(2).padStart(5)}  ${a.toFixed(2).padStart(5)}  ${r.toFixed(2).padStart(5)}`);
  }

  // Top 20 biggest disagreements (in either direction).
  const movers = matched.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  console.log(`\nTop 20 biggest disagreements`);
  console.log(`  ${'Player'.padEnd(18)} ${'Pos'.padEnd(4)} ${'Team'.padEnd(5)} ${'Ours'.padStart(6)} ${'FPLR'.padStart(6)} ${'Δ'.padStart(7)}  Why`);
  for (const { ref, ours, delta } of movers.slice(0, 20)) {
    const explanation = explainGap(ours, ref, delta);
    console.log(`  ${ours.web_name.padEnd(18)} ${ours.position.padEnd(4)} ${ours.team_short.padEnd(5)} ${ours.xpts_total.toFixed(2).padStart(6)} ${ref.xpts.toFixed(2).padStart(6)} ${delta >= 0 ? '+' : ''}${delta.toFixed(2).padStart(6)}  ${explanation[0]}`);
    for (const more of explanation.slice(1)) console.log(`  ${' '.repeat(50)}  ${more}`);
  }

  await sql.end();
}

main().catch(err => { console.error(err); process.exit(1); });
