#!/usr/bin/env tsx
/**
 * Weekly model diff + health report — sent by email each Monday.
 *
 * Catches structural drift early: which players moved most, which data
 * sources are healthy, which positions are calibrated. Stops me having
 * to manually audit the model every gameweek.
 *
 * What it reports:
 *   1. Top 15 climbers + 15 fallers by xPts change (current GW vs last
 *      snapshot stored in projection_snapshots)
 *   2. Calibration check: average xPts per position vs ACTUAL last GW
 *      (negative bias = under-rating, positive = over-rating)
 *   3. Data-source health:
 *        - Understat coverage (% of players resolved)
 *        - Bookmaker odds coverage (% of starters with implied probability)
 *        - Lineups coverage (% of starters with start_prob ≥ 0.99)
 *        - Last ingest timestamp per source
 *   4. Top 10 players by xPts for the upcoming GW (so the email is also
 *      a "morning briefing")
 *
 * Delivery:
 *   - Sends via Resend (https://resend.com) — free tier 100 emails/day,
 *     single POST call. Requires RESEND_API_KEY in env / GH secrets.
 *   - Recipient: REPORT_EMAIL env, defaults to george@open-source.io.
 *   - If RESEND_API_KEY is unset, the script prints the report to stdout
 *     and exits 0 — useful for local dry-runs.
 *
 * Trigger:
 *   GH Action `.github/workflows/weekly-report.yml`, cron 09:00 UTC Mondays.
 *   Can also be invoked manually:
 *     npm run report:weekly
 */
import { sql } from '../src/lib/db/client';

const RECIPIENT = process.env.REPORT_EMAIL ?? 'george@open-source.io';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = process.env.RESEND_FROM ?? 'FPL Trading Desk <onboarding@resend.dev>';

async function main() {
  const gwRow = await sql<Array<{ id: number; name: string }>>`
    SELECT id, name FROM gameweeks
     WHERE is_next = TRUE OR is_current = TRUE
     ORDER BY is_next DESC, is_current DESC LIMIT 1
  `;
  const gw = gwRow[0];
  if (!gw) { console.error('No current/next gameweek'); process.exit(1); }
  console.log(`[weekly-report] target gameweek: ${gw.name}`);

  const movers       = await loadTopMovers(gw.id);
  const calibration  = await loadCalibration();
  const sourceHealth = await loadSourceHealth(gw.id);
  const topByXpts    = await loadTopByXpts(gw.id);

  const subject = `FPL Desk — ${gw.name} model report`;
  const html = renderHtml({ gw, movers, calibration, sourceHealth, topByXpts });

  if (!RESEND_API_KEY) {
    console.log('\n[weekly-report] RESEND_API_KEY not set — dry-run mode, printing instead.\n');
    console.log(`Subject: ${subject}\n`);
    console.log(stripHtml(html));
    await sql.end({ timeout: 5 });
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${RESEND_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [RECIPIENT],
      subject,
      html
    })
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '<no body>');
    throw new Error(`Resend POST failed: ${res.status} ${errBody}`);
  }
  console.log(`[weekly-report] sent to ${RECIPIENT}`);
  await sql.end({ timeout: 5 });
}

/* ─── data loads ────────────────────────────────────────────────────────── */

interface MoverRow {
  webName: string; teamShort: string; position: string;
  xptsNow: number; xptsSnap: number; delta: number;
}

async function loadTopMovers(gwId: number): Promise<{ climbers: MoverRow[]; fallers: MoverRow[] }> {
  // Current projections summed across the GW's fixtures.
  const nowRows = await sql<Array<{
    player_id: number; web_name: string; team_short: string; position: string;
    xpts_now: number;
  }>>`
    SELECT pr.player_id, p.web_name, t.short_name AS team_short, p.position,
           SUM(pr.xpts_total)::float8 AS xpts_now
      FROM projections pr
      JOIN players p ON p.id = pr.player_id
      JOIN teams t   ON t.id = p.team_id
     WHERE pr.gameweek_id = ${gwId}
     GROUP BY pr.player_id, p.web_name, t.short_name, p.position
  `;
  // Latest snapshot summed across the GW's fixtures.
  let snapMap = new Map<number, number>();
  try {
    const snapRows = await sql<Array<{ player_id: number; xpts_snap: number }>>`
      WITH latest AS (
        SELECT DISTINCT ON (player_id, fixture_id)
               player_id, fixture_id, xpts_total::float8 AS xpts_total
          FROM projection_snapshots
         WHERE gameweek_id = ${gwId}
         ORDER BY player_id, fixture_id, captured_at DESC
      )
      SELECT player_id, SUM(xpts_total)::float8 AS xpts_snap
        FROM latest GROUP BY player_id
    `;
    snapMap = new Map(snapRows.map(r => [r.player_id, Number(r.xpts_snap)]));
  } catch {/* projection_snapshots may be empty */}

  const diffs = nowRows
    .filter(r => snapMap.has(r.player_id))
    .map(r => ({
      webName: r.web_name,
      teamShort: r.team_short,
      position: r.position,
      xptsNow: Number(r.xpts_now),
      xptsSnap: Number(snapMap.get(r.player_id) ?? 0),
      delta: Number(r.xpts_now) - Number(snapMap.get(r.player_id) ?? 0)
    }));

  const climbers = diffs.filter(d => d.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 15);
  const fallers  = diffs.filter(d => d.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 15);
  return { climbers, fallers };
}

interface CalibrationRow { position: string; n: number; meanPred: number; meanActual: number; bias: number }

async function loadCalibration(): Promise<CalibrationRow[]> {
  // Last finished GW: compare snapshot predictions to actuals.
  const lastRow = await sql<Array<{ id: number }>>`
    SELECT id FROM gameweeks WHERE finished = TRUE ORDER BY id DESC LIMIT 1
  `;
  if (!lastRow[0]) return [];
  const lastGw = lastRow[0].id;

  const rows = await sql<Array<{
    position: string; n: number; mean_pred: number; mean_actual: number;
  }>>`
    WITH snap AS (
      SELECT DISTINCT ON (player_id, fixture_id)
             player_id, fixture_id, xpts_total::float8 AS xpts_total
        FROM projection_snapshots
       WHERE gameweek_id = ${lastGw}
       ORDER BY player_id, fixture_id, captured_at DESC
    ),
    actuals AS (
      SELECT player_id, SUM(total_points)::float8 AS pts
        FROM player_gameweek_history
       WHERE gameweek_id = ${lastGw}
       GROUP BY player_id
    ),
    joined AS (
      SELECT p.position,
             SUM(snap.xpts_total) AS pred,
             COALESCE(MAX(a.pts), 0) AS actual
        FROM snap
        JOIN players p ON p.id = snap.player_id
        LEFT JOIN actuals a ON a.player_id = snap.player_id
       GROUP BY p.position, snap.player_id
    )
    SELECT position,
           COUNT(*)::int       AS n,
           AVG(pred)::float8   AS mean_pred,
           AVG(actual)::float8 AS mean_actual
      FROM joined
     GROUP BY position
     ORDER BY position
  `;
  return rows.map(r => ({
    position: r.position,
    n: Number(r.n),
    meanPred: Number(r.mean_pred),
    meanActual: Number(r.mean_actual),
    bias: Number(r.mean_pred) - Number(r.mean_actual)
  }));
}

interface SourceHealth {
  understatCoverage: number;
  oddsCoverage: number;
  lineupsCoverage: number;
  shotAggregatesCount: number;
  marketOddsCount: number;
  lineupsLockedCount: number;
  totalActivePlayers: number;
}

async function loadSourceHealth(gwId: number): Promise<SourceHealth> {
  const totalRows = await sql<Array<{ c: number }>>`
    SELECT COUNT(*)::int AS c FROM players WHERE status <> 'u'
  `;
  const totalActive = Number(totalRows[0]?.c ?? 1);

  let shotAggregatesCount = 0;
  try {
    const r = await sql<Array<{ c: number }>>`SELECT COUNT(*)::int AS c FROM player_shot_aggregates`;
    shotAggregatesCount = Number(r[0]?.c ?? 0);
  } catch {/* table may not exist */}

  let marketOddsCount = 0;
  try {
    const r = await sql<Array<{ c: number }>>`
      SELECT COUNT(DISTINCT player_id)::int AS c
        FROM market_odds_latest
       WHERE gameweek_id = ${gwId} AND market = 'player_goal'
    `;
    marketOddsCount = Number(r[0]?.c ?? 0);
  } catch {/* view may not exist */}

  let lineupsLockedCount = 0;
  try {
    const r = await sql<Array<{ c: number }>>`
      SELECT COUNT(DISTINCT player_id)::int AS c
        FROM minutes_projections
       WHERE start_prob >= 0.99
         AND fixture_id IN (SELECT id FROM fixtures WHERE gameweek_id = ${gwId})
    `;
    lineupsLockedCount = Number(r[0]?.c ?? 0);
  } catch {/* */}

  return {
    understatCoverage: shotAggregatesCount / totalActive,
    oddsCoverage:      marketOddsCount / Math.max(1, totalActive),
    lineupsCoverage:   lineupsLockedCount / 11 / 20, // 11 starters × 20 teams approx
    shotAggregatesCount,
    marketOddsCount,
    lineupsLockedCount,
    totalActivePlayers: totalActive
  };
}

async function loadTopByXpts(gwId: number) {
  return await sql<Array<{
    web_name: string; position: string; team_short: string;
    xpts: number; expected_minutes: number;
  }>>`
    SELECT p.web_name, p.position, t.short_name AS team_short,
           SUM(pr.xpts_total)::float8 AS xpts,
           COALESCE(MAX(mn.expected_minutes), 0)::float8 AS expected_minutes
      FROM projections pr
      JOIN players p ON p.id = pr.player_id
      JOIN teams   t ON t.id = p.team_id
      LEFT JOIN minutes_projections mn
        ON mn.player_id = pr.player_id AND mn.fixture_id = pr.fixture_id
     WHERE pr.gameweek_id = ${gwId}
     GROUP BY p.web_name, p.position, t.short_name
     ORDER BY xpts DESC
     LIMIT 15
  `;
}

/* ─── render ────────────────────────────────────────────────────────────── */

function renderHtml({ gw, movers, calibration, sourceHealth, topByXpts }: {
  gw: { id: number; name: string };
  movers: { climbers: MoverRow[]; fallers: MoverRow[] };
  calibration: CalibrationRow[];
  sourceHealth: SourceHealth;
  topByXpts: Array<{ web_name: string; position: string; team_short: string; xpts: number; expected_minutes: number }>;
}): string {
  const moverRow = (m: MoverRow, dir: 'up'|'down') => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #2a2a2a;">${escapeHtml(m.webName)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #2a2a2a;color:#aaa;font-family:monospace;font-size:12px;">${m.position} · ${m.teamShort}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #2a2a2a;text-align:right;font-family:monospace;font-size:12px;color:#999;">${m.xptsSnap.toFixed(2)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #2a2a2a;text-align:right;font-family:monospace;font-size:12px;">${m.xptsNow.toFixed(2)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #2a2a2a;text-align:right;font-family:monospace;font-size:13px;font-weight:600;color:${dir === 'up' ? '#3ddc97' : '#e57373'};">${dir === 'up' ? '+' : ''}${m.delta.toFixed(2)}</td>
    </tr>
  `;
  return `
<!doctype html>
<html><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#0a0a0a;color:#e8e8e8;">
<div style="max-width:680px;margin:0 auto;padding:24px;">
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#888;">FPL Trading Desk</div>
  <h1 style="font-size:22px;margin:4px 0 4px;">${escapeHtml(gw.name)} model report</h1>
  <p style="color:#999;font-size:13px;margin:0 0 24px;">${new Date().toUTCString()}</p>

  <h2 style="font-size:15px;margin:24px 0 8px;border-bottom:1px solid #333;padding-bottom:4px;">Data source health</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <tr>
      <td style="padding:4px 0;color:#aaa;">Understat per-shot xG</td>
      <td style="padding:4px 0;text-align:right;font-family:monospace;">${sourceHealth.shotAggregatesCount} / ${sourceHealth.totalActivePlayers} players (${(sourceHealth.understatCoverage*100).toFixed(0)}%)</td>
    </tr>
    <tr>
      <td style="padding:4px 0;color:#aaa;">Bookmaker odds</td>
      <td style="padding:4px 0;text-align:right;font-family:monospace;">${sourceHealth.marketOddsCount} players priced</td>
    </tr>
    <tr>
      <td style="padding:4px 0;color:#aaa;">Confirmed lineups (FotMob)</td>
      <td style="padding:4px 0;text-align:right;font-family:monospace;">${sourceHealth.lineupsLockedCount} starters locked</td>
    </tr>
  </table>

  <h2 style="font-size:15px;margin:24px 0 8px;border-bottom:1px solid #333;padding-bottom:4px;">Last GW calibration</h2>
  ${calibration.length === 0 ? `<p style="color:#999;">No finished gameweek yet.</p>` : `
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead>
      <tr style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px;">
        <th style="text-align:left;padding:4px;">Pos</th>
        <th style="text-align:right;padding:4px;">N</th>
        <th style="text-align:right;padding:4px;">Predicted</th>
        <th style="text-align:right;padding:4px;">Actual</th>
        <th style="text-align:right;padding:4px;">Bias</th>
      </tr>
    </thead>
    <tbody>
      ${calibration.map(c => `
        <tr>
          <td style="padding:4px;font-family:monospace;">${c.position}</td>
          <td style="padding:4px;text-align:right;font-family:monospace;color:#999;">${c.n}</td>
          <td style="padding:4px;text-align:right;font-family:monospace;">${c.meanPred.toFixed(2)}</td>
          <td style="padding:4px;text-align:right;font-family:monospace;">${c.meanActual.toFixed(2)}</td>
          <td style="padding:4px;text-align:right;font-family:monospace;color:${Math.abs(c.bias) > 0.5 ? '#e57373' : Math.abs(c.bias) > 0.25 ? '#f0c14b' : '#3ddc97'};">${c.bias >= 0 ? '+' : ''}${c.bias.toFixed(2)}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>`}

  <h2 style="font-size:15px;margin:24px 0 8px;border-bottom:1px solid #333;padding-bottom:4px;">Top movers since last snapshot</h2>
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#3ddc97;margin:8px 0 4px;">Climbers</div>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead><tr style="color:#888;font-size:11px;"><th style="text-align:left;padding:6px 10px;">Player</th><th style="text-align:left;padding:6px 10px;">Pos · Team</th><th style="text-align:right;padding:6px 10px;">Was</th><th style="text-align:right;padding:6px 10px;">Now</th><th style="text-align:right;padding:6px 10px;">Δ</th></tr></thead>
    <tbody>${movers.climbers.map(m => moverRow(m, 'up')).join('')}</tbody>
  </table>
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#e57373;margin:16px 0 4px;">Fallers</div>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead><tr style="color:#888;font-size:11px;"><th style="text-align:left;padding:6px 10px;">Player</th><th style="text-align:left;padding:6px 10px;">Pos · Team</th><th style="text-align:right;padding:6px 10px;">Was</th><th style="text-align:right;padding:6px 10px;">Now</th><th style="text-align:right;padding:6px 10px;">Δ</th></tr></thead>
    <tbody>${movers.fallers.map(m => moverRow(m, 'down')).join('')}</tbody>
  </table>

  <h2 style="font-size:15px;margin:24px 0 8px;border-bottom:1px solid #333;padding-bottom:4px;">Top 15 by xPts (${escapeHtml(gw.name)})</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead><tr style="color:#888;font-size:11px;"><th style="text-align:left;padding:6px 10px;">Player</th><th style="text-align:left;padding:6px 10px;">Pos · Team</th><th style="text-align:right;padding:6px 10px;">Mins</th><th style="text-align:right;padding:6px 10px;">xPts</th></tr></thead>
    <tbody>
      ${topByXpts.map(r => `
        <tr>
          <td style="padding:6px 10px;border-bottom:1px solid #2a2a2a;">${escapeHtml(r.web_name)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #2a2a2a;color:#aaa;font-family:monospace;font-size:12px;">${r.position} · ${r.team_short}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #2a2a2a;text-align:right;font-family:monospace;font-size:12px;color:#999;">${Math.round(r.expected_minutes)}′</td>
          <td style="padding:6px 10px;border-bottom:1px solid #2a2a2a;text-align:right;font-family:monospace;font-size:13px;font-weight:600;">${Number(r.xpts).toFixed(2)}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  <p style="color:#666;font-size:11px;margin-top:32px;text-align:center;">
    Auto-generated by FPL Trading Desk · Mondays at 09:00 UTC
  </p>
</div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]!));
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

main().catch(err => { console.error(err); process.exit(1); });
