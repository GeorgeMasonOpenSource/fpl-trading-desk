import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';
import { buildWarRoom } from '@/lib/mini-league/engine';
import { currentGameweek } from '@/lib/db/queries';
import { getManagerId, getLeagueId } from '@/lib/session';
import { NotConnected } from '@/components/NotConnected';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function MiniLeague() {
  const managerId = getManagerId();
  const leagueId  = getLeagueId();
  if (!managerId) return <NotConnected where="Mini League War Room" />;
  if (!leagueId)  return <Card title="No league connected"><p className="text-sm text-ink-muted">Add a Classic League ID via the connection bar (top-right) and refresh.</p></Card>;
  const gw = await currentGameweek();
  if (!gw) return <p className="text-ink-muted">No gameweek data yet — hit Refresh.</p>;
  const wr: any = await buildWarRoom(leagueId, managerId, gw.id);
  if (wr.empty) return <p className="text-ink-muted">{wr.message}</p>;
  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Mini league war room</div>
        <h1 className="text-2xl font-semibold">League {leagueId} · {gw.name}</h1>
      </header>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Threats" subtitle="High-EO rivals own, you don't">
          <Table>
            <THead><TH>Player</TH><TH>Team</TH><TH className="text-right">EO</TH><TH className="text-right">xPts</TH></THead>
            <tbody>
              {wr.threats.map((t: any) => (
                <TR key={t.playerId}>
                  <TD className="font-semibold">{t.webName}</TD>
                  <TD>{t.teamShort}</TD>
                  <TD className="text-right font-mono">{t.eo.toFixed(0)}%</TD>
                  <TD className="text-right font-mono">{t.projection.toFixed(2)}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card title="Helping you" subtitle="Low-EO differentials in your squad">
          <Table>
            <THead><TH>Player</TH><TH className="text-right">EO</TH><TH className="text-right">xPts</TH></THead>
            <tbody>
              {wr.help.map((h: any) => (
                <TR key={h.playerId}>
                  <TD className="font-semibold">{h.webName}</TD>
                  <TD className="text-right font-mono">{h.eo.toFixed(0)}%</TD>
                  <TD className="text-right font-mono">{h.projection.toFixed(2)}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
      <Card title="Captain differences">
        <Table>
          <THead><TH>Player</TH><TH className="text-right">Captained by %</TH><TH className="text-right">xPts</TH><TH>Yours?</TH></THead>
          <tbody>
            {wr.captainDiffs.slice(0, 8).map((c: any) => (
              <TR key={c.playerId}>
                <TD className="font-semibold">{c.webName}</TD>
                <TD className="text-right font-mono">{c.cappedByPct.toFixed(0)}%</TD>
                <TD className="text-right font-mono">{c.projection.toFixed(2)}</TD>
                <TD>{c.userCaptain ? <Badge tone="green">YES</Badge> : <Badge tone="steel">no</Badge>}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card title="Point-swing events">
        <ul className="text-sm text-ink-muted space-y-1">
          {wr.swings.slice(0, 8).map((s: any) => (
            <li key={s.playerId}>A {s.webName} goal costs you ≈ <span className="font-mono text-ink">{s.costPerGoalIfNotOwned}</span> pts vs the league.</li>
          ))}
        </ul>
      </Card>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="Safe play"><p className="text-sm">{wr.safePlay}</p></Card>
        <Card title="Aggressive play"><p className="text-sm">{wr.aggressivePlay}</p></Card>
      </div>
    </div>
  );
}
