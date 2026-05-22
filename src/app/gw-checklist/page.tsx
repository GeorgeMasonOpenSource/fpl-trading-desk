import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';
import { sql } from '@/lib/db/client';
import { getManagerId } from '@/lib/session';
import { NotConnected } from '@/components/NotConnected';
import { rankCaptains } from '@/lib/captaincy/engine';
import { buildEnsemble } from '@/lib/projections/ensemble';
import { fmt } from '@/lib/util/fmt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 60;

/**
 * GW Checklist — single page bringing every signal we have into one
 * pre-deadline decision view:
 *
 *   1. Captain choices, risk-adjusted
 *   2. Squad with model xPts vs market-blended xPts (ensemble)
 *   3. Lineup-leak status (what's confirmed, what's still guessed)
 *   4. Creator consensus picks (buying/selling)
 *   5. Press-conference flags from creators (injury / start news)
 *
 * Purpose: a single scroll that surfaces every input before you submit
 * your team. Built for crunch-time — when the deadline is 60 minutes out
 * and you want to make ONE decision per surface, not bounce between five
 * pages.
 */
export default async function GwChecklistPage() {
  const managerId = getManagerId();
  if (!managerId) return <NotConnected where="GW Checklist" />;

  const gwRow = await sql<Array<{ id: number; name: string; deadline_time: string }>>`
    SELECT id, name, deadline_time
      FROM gameweeks WHERE deadline_time > now()
     ORDER BY deadline_time ASC LIMIT 1
  `;
  const gw = gwRow[0];
  if (!gw) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">No upcoming gameweek</h1>
        <p className="text-ink-muted">Season finished — see /backtesting for the year-in-review.</p>
      </div>
    );
  }

  // Captain ranking (risk-adjusted, ensemble-aware).
  const captains = await rankCaptains(managerId, gw.id).catch(() => null);

  // Ensemble per-player for this GW. Use the rows where the user owns the
  // player so we can show a squad-only blended view.
  const ensemble = await buildEnsemble(gw.id).catch(() => []);
  const ensembleByPlayer = new Map(ensemble.map(e => [e.playerId, e]));

  // Squad with confirmed-start indicator.
  const squad = await sql<Array<{
    player_id: number; position: number; web_name: string;
    pos: 'GKP'|'DEF'|'MID'|'FWD'; team_short: string;
    xpts_total: number; start_prob: number; minutes_confidence: number;
  }>>`
    SELECT mp.player_id, mp.position, p.web_name, p.position AS pos,
           t.short_name AS team_short,
           COALESCE(SUM(pr.xpts_total), 0) AS xpts_total,
           COALESCE(MAX(mn.start_prob), 0)  AS start_prob,
           COALESCE(MAX(mn.minutes_confidence), 0) AS minutes_confidence
      FROM manager_picks mp
      JOIN players p ON p.id = mp.player_id
      JOIN teams t   ON t.id = p.team_id
      LEFT JOIN projections pr ON pr.player_id = p.id AND pr.gameweek_id = ${gw.id}
      LEFT JOIN minutes_projections mn ON mn.player_id = p.id
        AND mn.fixture_id IN (SELECT id FROM fixtures WHERE gameweek_id = ${gw.id})
     WHERE mp.manager_id = ${managerId} AND mp.gameweek_id = ${gw.id}
     GROUP BY mp.player_id, mp.position, p.web_name, p.position, t.short_name
     ORDER BY mp.position
  `;

  // Creator consensus buys / sells for squad players.
  const squadIds = squad.map(s => s.player_id);
  const consensus = squadIds.length === 0 ? [] : await sql<Array<{
    player_id: number; signal_kind: string;
    distinct_creators: number; creator_names: string[];
  }>>`
    SELECT player_id, signal_kind, distinct_creators, creator_names
      FROM creator_consensus
     WHERE player_id IN ${sql(squadIds as any)}
       AND distinct_creators >= 2
  `;
  interface ConsensusRow { player_id: number; signal_kind: string; distinct_creators: number; creator_names: string[] }
  const consensusByPlayer = new Map<number, ConsensusRow[]>();
  for (const c of consensus) {
    if (!consensusByPlayer.has(c.player_id)) consensusByPlayer.set(c.player_id, []);
    consensusByPlayer.get(c.player_id)!.push(c);
  }

  const oddsCoverage = ensemble.filter(e => e.marketAvailable).length;
  const oddsCoveragePct = ensemble.length > 0 ? (oddsCoverage / ensemble.length) * 100 : 0;
  const lineupLocked = squad.filter(s => Number(s.minutes_confidence) > 0.95).length;

  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Pre-deadline</div>
        <h1 className="text-2xl font-semibold">
          {gw.name} checklist
        </h1>
        <p className="text-sm text-ink-muted mt-1">
          Deadline: {new Date(gw.deadline_time).toUTCString().slice(0, 22)}
        </p>
        <div className="flex flex-wrap gap-2 mt-3 text-xs">
          <Badge tone={oddsCoveragePct > 50 ? 'green' : oddsCoveragePct > 0 ? 'amber' : 'red'}>
            market odds: {oddsCoverage} players ({oddsCoveragePct.toFixed(0)}%)
          </Badge>
          <Badge tone={lineupLocked === squad.length ? 'green' : lineupLocked > 0 ? 'amber' : 'steel'}>
            lineup confirmed: {lineupLocked}/{squad.length} squad
          </Badge>
        </div>
      </header>

      {/* CAPTAINCY — biggest weekly decision, top of page */}
      <Card
        title="Captain"
        subtitle="Risk-adjusted = blended xPts − 0.30 × spread. Beats raw EV when avoiding variance."
      >
        {captains?.recommended ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <CaptainCard label="Recommended" pick={captains.recommended} tone="green" />
            {captains.safe       && <CaptainCard label="Safe (high floor)" pick={captains.safe} tone="blue" />}
            {captains.aggressive && <CaptainCard label="Aggressive (high ceiling)" pick={captains.aggressive} tone="violet" />}
          </div>
        ) : (
          <p className="text-sm text-ink-muted">No projections yet — run db:seed.</p>
        )}
        {captains?.ranked && captains.ranked.length > 0 && (
          <div className="mt-4">
            <div className="text-[10px] uppercase tracking-widest text-ink-dim mb-1">Full ranking</div>
            <Table>
              <THead>
                <TH>Player</TH>
                <TH className="text-right">Risk-adj</TH>
                <TH className="text-right">EV (cap)</TH>
                <TH className="text-right">Model→Mkt</TH>
                <TH className="text-right">Spread</TH>
                <TH>Reasons</TH>
              </THead>
              <tbody>
                {captains.ranked.slice(0, 8).map(c => (
                  <TR key={c.playerId}>
                    <TD className="font-medium">{c.webName} <span className="text-ink-dim text-xs">{c.position}·{c.teamShort}</span></TD>
                    <TD className="text-right font-mono">{fmt(c.riskAdjusted, 2)}</TD>
                    <TD className="text-right font-mono">{fmt(c.projectionBlended, 2)}</TD>
                    <TD className="text-right font-mono text-ink-dim">{fmt(c.projection, 1)} → {fmt(c.projectionBlended, 1)}</TD>
                    <TD className="text-right font-mono">{fmt(c.ceiling - c.floor, 1)}</TD>
                    <TD className="text-xs text-ink-dim">{c.reasons.slice(0, 2).join(' · ')}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>

      {/* SQUAD — model vs market */}
      <Card
        title="Your squad — model vs market"
        subtitle="When the market disagrees with the model, that's news worth checking."
      >
        <Table>
          <THead>
            <TH>Player</TH>
            <TH>Pos</TH>
            <TH className="text-right">Model xPts</TH>
            <TH className="text-right">Blended xPts</TH>
            <TH className="text-right">Δ</TH>
            <TH className="text-right">Start prob</TH>
            <TH>Confirmed?</TH>
            <TH>Creator buzz</TH>
          </THead>
          <tbody>
            {squad.map(p => {
              const e = ensembleByPlayer.get(p.player_id);
              const blended = e?.blendedXpts ?? Number(p.xpts_total);
              const delta = blended - Number(p.xpts_total);
              const confirmed = Number(p.minutes_confidence) > 0.95;
              const buzz = consensusByPlayer.get(p.player_id) ?? [];
              return (
                <TR key={p.player_id} className={p.position > 11 ? 'opacity-60' : ''}>
                  <TD className="font-medium">{p.web_name}</TD>
                  <TD className="font-mono text-xs">{p.pos}·{p.team_short}</TD>
                  <TD className="text-right font-mono">{fmt(p.xpts_total, 2)}</TD>
                  <TD className="text-right font-mono">{fmt(blended, 2)}</TD>
                  <TD className={`text-right font-mono ${
                    Math.abs(delta) < 0.3 ? 'text-ink-dim' :
                    delta > 0 ? 'text-accent-green' : 'text-accent-red'
                  }`}>
                    {delta >= 0 ? '+' : ''}{fmt(delta, 2)}
                  </TD>
                  <TD className="text-right font-mono">{(Number(p.start_prob) * 100).toFixed(0)}%</TD>
                  <TD>
                    {confirmed
                      ? <Badge tone={Number(p.start_prob) >= 0.5 ? 'green' : 'red'}>
                          {Number(p.start_prob) >= 0.5 ? 'starts' : 'benched'}
                        </Badge>
                      : <span className="text-[10px] text-ink-dim">guessed</span>}
                  </TD>
                  <TD className="text-xs">
                    {buzz.length === 0
                      ? <span className="text-ink-dim">—</span>
                      : buzz.map(b => (
                          <Badge key={b.signal_kind} tone={
                            b.signal_kind === 'buying' || b.signal_kind === 'recommend' ? 'green' :
                            b.signal_kind === 'selling' ? 'red' : 'amber'
                          } className="mr-1">
                            {b.signal_kind} ×{b.distinct_creators}
                          </Badge>
                        ))}
                  </TD>
                </TR>
              );
            })}
          </tbody>
        </Table>
      </Card>

      {/* HOW TO GET FULL COVERAGE */}
      <Card title="Data coverage checklist" subtitle="Run these in order before the deadline.">
        <ul className="text-sm space-y-2 list-disc list-inside text-ink-muted">
          <li>
            <code className="font-mono">npm run ingest:youtube</code> — pull latest creator videos
            (Manager Quotes tab shows press-conference content within them)
          </li>
          <li>
            <code className="font-mono">npm run ingest:odds</code> — pull bookmaker player-goalscorer
            odds (requires ODDS_API_KEY env var)
          </li>
          <li>
            <code className="font-mono">npm run ingest:lineups</code> — once kick-off is &lt; 60min
            away, pull confirmed XIs from FotMob
          </li>
          <li>
            <code className="font-mono">npm run db:seed</code> — re-runs the projection engine so
            the new minutes / odds / signals flow into xPts
          </li>
          <li>
            <code className="font-mono">npm run ingest:league</code> — refresh rival picks for
            the mini-league war room
          </li>
        </ul>
      </Card>
    </div>
  );
}

function CaptainCard({
  label, pick, tone
}: {
  label: string;
  pick: any;
  tone: 'green' | 'blue' | 'violet';
}) {
  return (
    <div className="bg-bg-inset border border-line rounded-md p-3 space-y-2">
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] uppercase tracking-widest text-ink-dim">{label}</div>
        <Badge tone={tone}>C</Badge>
      </div>
      <div className="font-semibold text-lg">{pick.webName}</div>
      <div className="text-[10px] text-ink-dim font-mono">
        {pick.position} · {pick.teamShort}
      </div>
      <div className="grid grid-cols-3 gap-1 text-[11px] font-mono">
        <div>
          <div className="text-ink-dim text-[9px]">RA-EV</div>
          <div>{fmt(pick.riskAdjusted, 2)}</div>
        </div>
        <div>
          <div className="text-ink-dim text-[9px]">CAP EV</div>
          <div>{fmt(pick.projectionBlended, 2)}</div>
        </div>
        <div>
          <div className="text-ink-dim text-[9px]">CEILING</div>
          <div>{fmt(pick.ceiling, 1)}</div>
        </div>
      </div>
      {pick.reasons?.length > 0 && (
        <div className="text-[10px] text-ink-dim">{pick.reasons.slice(0, 2).join(' · ')}</div>
      )}
    </div>
  );
}
