import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';
import { rankCaptains } from '@/lib/captaincy/engine';
import { currentGameweek } from '@/lib/db/queries';
import { getManagerId, getLeagueId } from '@/lib/session';
import { NotConnected } from '@/components/NotConnected';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function CaptaincyPage() {
  const managerId = getManagerId();
  if (!managerId) return <NotConnected where="Captaincy" />;
  const leagueId = getLeagueId() ?? undefined;
  const gw = await currentGameweek();
  if (!gw) return <p className="text-ink-muted">No gameweek data yet — hit Refresh.</p>;
  const out = await rankCaptains(managerId, gw.id, leagueId);
  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Captaincy</div>
        <h1 className="text-2xl font-semibold">{gw.name} captain ranking</h1>
      </header>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Tile label="Safe"       v={out.safe} />
        <Tile label="Aggressive" v={out.aggressive} />
        <Tile label="Mini league" v={out.miniLeague} />
        <Tile label="TC candidate" v={out.tripleCaptainCandidate} />
      </div>
      <Card title="Full ranking">
        <Table>
          <THead>
            <TH>Player</TH>
            <TH>Pos</TH>
            <TH>Team</TH>
            <TH className="text-right">xPts (×2)</TH>
            <TH className="text-right">Ceiling</TH>
            <TH className="text-right">Floor</TH>
            <TH className="text-right">Start %</TH>
            <TH className="text-right">EO</TH>
            <TH className="text-right">ML impact</TH>
            <TH className="text-right">TC score</TH>
            <TH>Notes</TH>
          </THead>
          <tbody>
            {out.ranked.map(r => (
              <TR key={r.playerId}>
                <TD className="font-semibold">{r.webName}</TD>
                <TD>{r.position}</TD>
                <TD>{r.teamShort}</TD>
                <TD className="text-right font-mono">{r.projection.toFixed(2)}</TD>
                <TD className="text-right font-mono">{r.ceiling.toFixed(2)}</TD>
                <TD className="text-right font-mono">{r.floor.toFixed(2)}</TD>
                <TD className="text-right font-mono">{(r.startProb*100).toFixed(0)}%</TD>
                <TD className="text-right font-mono">{r.effectiveOwnershipPct.toFixed(0)}%</TD>
                <TD className="text-right font-mono">{r.miniLeagueImpact.toFixed(2)}</TD>
                <TD className="text-right font-mono">{r.tripleCaptainScore.toFixed(2)}</TD>
                <TD className="text-xs text-ink-muted">{r.reasons.join('; ')}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

function Tile({ label, v }: { label: string; v: any }) {
  if (!v) return <Card title={label}><p className="text-ink-muted text-sm">—</p></Card>;
  return (
    <Card title={label} action={<Badge tone="blue">{(v.startProb*100).toFixed(0)}% start</Badge>}>
      <div className="text-xl font-semibold">{v.webName}</div>
      <div className="text-sm text-ink-muted">{v.position} · {v.teamShort}</div>
      <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-sm">
        <div><span className="text-ink-dim text-[10px] block">xPts</span>{v.projection.toFixed(2)}</div>
        <div><span className="text-ink-dim text-[10px] block">Ceil</span>{v.ceiling.toFixed(2)}</div>
        <div><span className="text-ink-dim text-[10px] block">EO</span>{v.effectiveOwnershipPct.toFixed(0)}%</div>
      </div>
    </Card>
  );
}
