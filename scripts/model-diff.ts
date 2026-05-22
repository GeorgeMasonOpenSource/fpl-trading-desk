#!/usr/bin/env tsx
/**
 * Show the top movers between the CURRENT projections table and the most
 * recent snapshot for the same gameweek.
 *
 * Purpose: after `recompute:all`, the projections table has the NEW
 * model output. The projection_snapshots table still holds the OLD
 * model's numbers. Diff them to see which players moved the most.
 *
 * If nothing moved at all, the new modules aren't flowing through and
 * we have an integration bug to chase. If the top movers are pen-takers
 * dropping (Le Fée, Palmer) and high-Understat-xG players climbing, the
 * Understat data is doing its job.
 *
 * Usage:
 *   npm run model:diff               # current GW
 *   GW=37 npm run model:diff         # specific GW
 */
import { sql } from '../src/lib/db/client';

async function main() {
  const gwArg = process.env.GW ? Number(process.env.GW) : null;
  const gw = gwArg ?? await detectGw();
  console.log(`→ GW ${gw}: top movers (current projections vs latest snapshot)\n`);

  // Pull current projections summed across all the GW's fixtures per player.
  const currentRows = await sql<Array<{ player_id: number; web_name: string; team_short: string; pos: string; xpts_now: number; }>>`
    SELECT pr.player_id, p.web_name, t.short_name AS team_short, p.position AS pos,
           SUM(pr.xpts_total)::float8 AS xpts_now
      FROM projections pr
      JOIN players p ON p.id = pr.player_id
      JOIN teams t   ON t.id = p.team_id
     WHERE pr.gameweek_id = ${gw}
     GROUP BY pr.player_id, p.web_name, t.short_name, p.position
  `;
  const snapRows = await sql<Array<{ player_id: number; xpts_snap: number }>>`
    WITH latest AS (
      SELECT DISTINCT ON (player_id, fixture_id)
             player_id, fixture_id, xpts_total::float8 AS xpts_total
        FROM projection_snapshots
       WHERE gameweek_id = ${gw}
       ORDER BY player_id, fixture_id, captured_at DESC
    )
    SELECT player_id, SUM(xpts_total)::float8 AS xpts_snap
      FROM latest
     GROUP BY player_id
  `;
  const snapMap = new Map(snapRows.map(r => [r.player_id, Number(r.xpts_snap)]));
  if (snapRows.length === 0) {
    console.log(`  No snapshot rows for GW${gw}. Run db:seed to capture one, then compare next time.`);
    process.exit(0);
  }

  const diffs = currentRows
    .map(r => ({
      ...r,
      xpts_now: Number(r.xpts_now),
      xpts_snap: snapMap.get(r.player_id) ?? null,
      delta: snapMap.has(r.player_id)
        ? Number(r.xpts_now) - Number(snapMap.get(r.player_id))
        : null
    }))
    .filter(r => r.delta != null);

  if (diffs.length === 0) {
    console.log(`  No matching players between projections and snapshot — odd. Did seed run?`);
    process.exit(0);
  }

  const movers = diffs.slice().sort((a, b) => Math.abs((b.delta ?? 0)) - Math.abs((a.delta ?? 0)));
  const climbers = diffs.slice().filter(r => (r.delta ?? 0) > 0).sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0));
  const fallers  = diffs.slice().filter(r => (r.delta ?? 0) < 0).sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0));

  console.log(`  ${diffs.length} players compared\n`);
  console.log(`  TOP 15 CLIMBERS (new model rates them higher):`);
  console.log(`  ${'Player'.padEnd(20)} ${'Pos'.padEnd(4)} ${'Team'.padEnd(5)} ${'Old'.padStart(7)} ${'New'.padStart(7)} ${'Δ'.padStart(7)}`);
  for (const r of climbers.slice(0, 15)) {
    console.log(`  ${r.web_name.padEnd(20)} ${r.pos.padEnd(4)} ${r.team_short.padEnd(5)} ${(r.xpts_snap ?? 0).toFixed(2).padStart(7)} ${r.xpts_now.toFixed(2).padStart(7)} ${(r.delta ?? 0).toFixed(2).padStart(7)}`);
  }
  console.log(`\n  TOP 15 FALLERS (new model rates them lower — pen-takers should appear here):`);
  console.log(`  ${'Player'.padEnd(20)} ${'Pos'.padEnd(4)} ${'Team'.padEnd(5)} ${'Old'.padStart(7)} ${'New'.padStart(7)} ${'Δ'.padStart(7)}`);
  for (const r of fallers.slice(0, 15)) {
    console.log(`  ${r.web_name.padEnd(20)} ${r.pos.padEnd(4)} ${r.team_short.padEnd(5)} ${(r.xpts_snap ?? 0).toFixed(2).padStart(7)} ${r.xpts_now.toFixed(2).padStart(7)} ${(r.delta ?? 0).toFixed(2).padStart(7)}`);
  }

  const absDeltas = diffs.map(d => Math.abs(d.delta ?? 0));
  const meanAbs = absDeltas.reduce((s, x) => s + x, 0) / absDeltas.length;
  const movedSubstantially = absDeltas.filter(x => x > 0.5).length;
  console.log(`\n  Mean absolute change: ${meanAbs.toFixed(3)} xPts`);
  console.log(`  Players that moved by >0.5 xPts: ${movedSubstantially} / ${diffs.length}`);
  console.log(`  Maximum absolute change: ${Math.max(...absDeltas).toFixed(2)} xPts (${movers[0]?.web_name})`);

  if (meanAbs < 0.05) {
    console.log(`\n  ⚠️  Mean change is tiny. The new modules likely did NOT flow into the projection engine.`);
    console.log(`      Check: does player_shot_aggregates have rows? Does engine.ts JOIN it? Did the recompute actually run for this GW?`);
  } else {
    console.log(`\n  ✅  Projections HAVE changed meaningfully. The new modules are in effect.`);
  }
  await sql.end();
}

async function detectGw(): Promise<number> {
  const rows = await sql<Array<{ id: number }>>`
    SELECT id FROM gameweeks WHERE is_next = TRUE OR is_current = TRUE
     ORDER BY is_next DESC, is_current DESC LIMIT 1
  `;
  if (!rows[0]) throw new Error('No current/next gameweek');
  return rows[0].id;
}

main().catch(err => { console.error(err); process.exit(1); });
