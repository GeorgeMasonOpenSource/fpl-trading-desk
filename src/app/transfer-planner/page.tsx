import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';
import { compareTransferScenarios } from '@/lib/transfers/optimiser';
import { currentGameweek, managerSummary } from '@/lib/db/queries';
import { getManagerId } from '@/lib/session';
import { NotConnected } from '@/components/NotConnected';
import { WhatIfTransfer } from '@/components/WhatIfTransfer';
import { listMySquad, listCandidates } from '@/app/actions/whatif';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function TransferPlanner() {
  const managerId = getManagerId();
  if (!managerId) return <NotConnected where="Transfer Planner" />;
  const gw = await currentGameweek();
  if (!gw) return <p className="text-ink-muted">No gameweek data yet — hit Refresh.</p>;

  const summary = await managerSummary(managerId);
  const scenarios = await compareTransferScenarios({
    managerId, startGameweek: gw.id,
    freeTransfers: summary?.free_transfers ?? 1,
    evThreshold:  Number(process.env.EV_TRANSFER_THRESHOLD ?? 0.6),
    hitThreshold: Number(process.env.EV_HIT_THRESHOLD ?? 1.5)
  });

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
