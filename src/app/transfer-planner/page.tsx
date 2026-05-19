import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';
import { compareTransferScenarios, rankTopTransfers } from '@/lib/transfers/optimiser';
import { getTransferInsights } from '@/lib/transfers/insights';
import { TransferWhy } from '@/components/TransferWhy';
import { getGameweeks, managerSummary } from '@/lib/db/queries';
import { getManagerId } from '@/lib/session';
import { NotConnected } from '@/components/NotConnected';
import { WhatIfTransfer } from '@/components/WhatIfTransfer';
import { listMySquad, listCandidates } from '@/app/actions/whatif';
import { fmt } from '@/lib/util/fmt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function TransferPlanner() {
  const managerId = getManagerId();
  if (!managerId) return <NotConnected where="Transfer Planner" />;
  // Use the planning gameweek (next not-yet-deadline GW) when one exists,
  // otherwise fall back to current. This matches the dashboard's "planning"
  // behaviour so the rankings line up with where you'll actually transfer.
  const gws = await getGameweeks();
  const gw = gws.planning ?? gws.current ?? gws.next;
  if (!gw) return <p className="text-ink-muted">No gameweek data yet — hit Refresh.</p>;

  const summary = await managerSummary(managerId);
  const [scenarios, topTransfers] = await Promise.all([
    compareTransferScenarios({
      managerId, startGameweek: gw.id,
      freeTransfers: summary?.free_transfers ?? 1,
      evThreshold:  Number(process.env.EV_TRANSFER_THRESHOLD ?? 0.6),
      hitThreshold: Number(process.env.EV_HIT_THRESHOLD ?? 1.5)
    }),
    rankTopTransfers(managerId, gw.id, 10)
  ]);

  // Pull the recent-form + upcoming-fixture context for every player involved
  // in the top-10 list (both sides), so the user can audit each suggestion.
  const involvedIds = Array.from(new Set(
    topTransfers.flatMap(t => [t.out.playerId, t.in.playerId])
  ));
  const insights = await getTransferInsights(involvedIds, gw.id);

  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Transfer planner</div>
        <h1 className="text-2xl font-semibold">Routes from {gw.name}</h1>
        <p className="text-sm text-ink-muted mt-1">
          Every route is priced. Do nothing and roll are always live options. A move is
          only recommended if EV clears the threshold.
        </p>
      </header>
      <Card title="Scenario comparison" subtitle="EV gains over 1, 3, 6 and 8 GW horizons">
        <Table>
          <THead>
            <TH>Scenario</TH>
            <TH className="text-right">EV (3 GW)</TH>
            <TH className="text-right">1 GW</TH>
            <TH className="text-right">6 GW</TH>
            <TH className="text-right">8 GW</TH>
            <TH className="text-right">Risk</TH>
            <TH className="text-right">Confidence</TH>
            <TH className="text-right">Flex</TH>
            <TH>Moves</TH>
          </THead>
          <tbody>
            {scenarios.map(s => (
              <TR key={s.scenario}>
                <TD><Badge tone={s.ev > 1.5 ? 'green' : s.ev > 0 ? 'amber' : 'steel'}>{s.scenario}</Badge></TD>
                <TD className="text-right font-mono">{s.ev.toFixed(2)}</TD>
                <TD className="text-right font-mono">{s.evGainByHorizon[1].toFixed(2)}</TD>
                <TD className="text-right font-mono">{s.evGainByHorizon[6].toFixed(2)}</TD>
                <TD className="text-right font-mono">{s.evGainByHorizon[8].toFixed(2)}</TD>
                <TD className="text-right font-mono">{(s.risk*100).toFixed(0)}%</TD>
                <TD className="text-right font-mono">{(s.confidence*100).toFixed(0)}%</TD>
                <TD className="text-right font-mono">{(s.flexibilityScore*100).toFixed(0)}%</TD>
                <TD className="text-xs text-ink-muted">
                  {s.moves.map(m => `${m.out.webName} → ${m.in.webName}`).join('; ') || '—'}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card
        title={`Top 10 transfers for ${gw.name}`}
        subtitle="Ranked by expected Starting-XI points gained next gameweek. Captain doubling and bench-utility factored in."
      >
        {topTransfers.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No legal upgrades found — your squad is at maximum projected XI EV
            given your bank and the 3-per-club cap.
          </p>
        ) : (
          <div className="space-y-1">
            <div className="grid grid-cols-[24px_1fr_1fr_64px_64px_64px_64px_90px] gap-x-3 px-3 py-2 text-[10px] uppercase tracking-widest text-ink-dim border-b border-line">
              <div>#</div><div>Out</div><div>In</div>
              <div className="text-right">+pts GW{gw.id}</div>
              <div className="text-right">+3 GW</div>
              <div className="text-right">+6 GW</div>
              <div className="text-right">Net £</div>
              <div>Flags</div>
            </div>
            {topTransfers.map(t => (
              <details
                key={`${t.out.playerId}-${t.in.playerId}`}
                className="group bg-bg-card border border-line rounded-md open:bg-bg-inset"
              >
                <summary className="cursor-pointer list-none px-3 py-2 hover:bg-bg-inset rounded-md">
                  <div className="grid grid-cols-[24px_1fr_1fr_64px_64px_64px_64px_90px] gap-x-3 items-center">
                    <div className="font-mono text-ink-dim">{t.rank}</div>
                    <div>
                      <div className="font-medium">
                        {t.out.webName}
                        <span className="ml-2 font-mono text-xs text-ink-dim">{fmt(t.out.xpts1, 2)} xPts</span>
                      </div>
                      <div className="text-[10px] text-ink-dim font-mono">
                        {t.out.position} · {t.out.teamShort} · £{(t.out.cost / 10).toFixed(1)}m
                      </div>
                    </div>
                    <div>
                      <div className="font-medium">
                        {t.in.webName}
                        <span className="ml-2 font-mono text-xs text-accent-green">{fmt(t.in.xpts1, 2)} xPts</span>
                      </div>
                      <div className="text-[10px] text-ink-dim font-mono">
                        {t.in.position} · {t.in.teamShort} · £{(t.in.cost / 10).toFixed(1)}m
                      </div>
                    </div>
                    <div className={`text-right font-mono ${t.evGain1 > 0.5 ? 'text-accent-green' : ''}`}>
                      +{fmt(t.evGain1, 2)}
                    </div>
                    <div className="text-right font-mono">+{fmt(t.evGain3, 2)}</div>
                    <div className="text-right font-mono">+{fmt(t.evGain6, 2)}</div>
                    <div className={`text-right font-mono ${t.netCost <= 0 ? 'text-accent-green' : 'text-ink-muted'}`}>
                      {t.netCost === 0 ? '—' : `${t.netCost > 0 ? '-' : '+'}£${(Math.abs(t.netCost) / 10).toFixed(1)}m`}
                    </div>
                    <div className="space-x-1">
                      {t.startsImmediately && <Badge tone="green">starts</Badge>}
                      {t.changesCaptain && <Badge tone="violet">new C</Badge>}
                    </div>
                  </div>
                  <div className="mt-1 text-[10px] text-ink-dim group-open:hidden">
                    click to see recent form + upcoming fixtures →
                  </div>
                </summary>
                <div className="px-3 py-3 border-t border-line">
                  <TransferWhy
                    outName={t.out.webName}
                    inName={t.in.webName}
                    outInsight={insights.get(t.out.playerId)}
                    inInsight={insights.get(t.in.playerId)}
                  />
                </div>
              </details>
            ))}
          </div>
        )}
      </Card>

      <Card title="Why these routes?">
        <ul className="text-sm text-ink-muted space-y-2">
          {scenarios.map(s => (
            <li key={s.scenario}><span className="font-mono text-ink">{s.scenario}:</span> {s.reasons.join(' ')}</li>
          ))}
        </ul>
      </Card>

      <WhatIfPanel />
    </div>
  );
}

async function WhatIfPanel() {
  const squad = await listMySquad();
  // Build a candidates map keyed by position so the client can swap dropdowns
  // without round-tripping for each pick.
  const byPos: Record<string, Awaited<ReturnType<typeof listCandidates>>> = {};
  for (const pos of ['GKP', 'DEF', 'MID', 'FWD']) {
    byPos[pos] = await listCandidates(pos, 150);
  }
  return <WhatIfTransfer squad={squad} candidatesByPosition={byPos} />;
}
