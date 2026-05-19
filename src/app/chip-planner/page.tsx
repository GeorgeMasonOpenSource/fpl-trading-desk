import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';
import { simulateChips } from '@/lib/chips/engine';
import { currentGameweek } from '@/lib/db/queries';
import { getManagerId } from '@/lib/session';
import { NotConnected } from '@/components/NotConnected';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ChipPlanner() {
  const managerId = getManagerId();
  if (!managerId) return <NotConnected where="Chip Planner" />;
  const gw = await currentGameweek();
  if (!gw) return <p className="text-ink-muted">No gameweek data yet — hit Refresh.</p>;
  const chips = await simulateChips(managerId, gw.id, gw.id + 6);
  const byChip = ['WC', 'FH', 'BB', 'TC'].map(name => ({
    name,
    rows: chips.filter(c => c.chip === name).sort((a, b) => a.gameweekId - b.gameweekId),
    best: chips.filter(c => c.chip === name).sort((a, b) => b.ev - a.ev)[0]
  }));
  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Chip planner</div>
        <h1 className="text-2xl font-semibold">Chip value timeline</h1>
      </header>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {byChip.map(b => (
          <Card key={b.name} title={chipFullName(b.name)} action={<Badge>{b.best ? `GW ${b.best.gameweekId}` : '—'}</Badge>}>
            <div className="text-2xl font-mono">{b.best ? b.best.ev.toFixed(1) : '—'}</div>
            <div className="text-[11px] text-ink-dim">best projected EV</div>
            <div className="mt-3 flex gap-2 text-[11px] text-ink-muted">
              <span>risk {b.best ? (b.best.risk*100).toFixed(0) : 0}%</span>
              <span>confidence {b.best ? (b.best.confidence*100).toFixed(0) : 0}%</span>
            </div>
          </Card>
        ))}
      </div>
      {byChip.map(b => (
        <Card key={b.name} title={`${chipFullName(b.name)} · per gameweek`}>
          <Table>
            <THead>
              <TH>GW</TH>
              <TH className="text-right">EV</TH>
              <TH className="text-right">Risk</TH>
              <TH className="text-right">Confidence</TH>
              <TH>Notes</TH>
            </THead>
            <tbody>
              {b.rows.map(r => (
                <TR key={r.gameweekId}>
                  <TD>{r.gameweekId}</TD>
                  <TD className="text-right font-mono">{r.ev.toFixed(2)}</TD>
                  <TD className="text-right font-mono">{(r.risk*100).toFixed(0)}%</TD>
                  <TD className="text-right font-mono">{(r.confidence*100).toFixed(0)}%</TD>
                  <TD className="text-xs text-ink-muted">{JSON.stringify(r.payload)}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      ))}
    </div>
  );
}

function chipFullName(c: string) {
  return c === 'WC' ? 'Wildcard'
       : c === 'FH' ? 'Free Hit'
       : c === 'BB' ? 'Bench Boost'
       : 'Triple Captain';
}
