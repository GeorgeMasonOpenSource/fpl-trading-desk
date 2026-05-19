import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';
import { buildWarRoom } from '@/lib/mini-league/engine';
import { currentGameweek } from '@/lib/db/queries';
import { getManagerId, getLeagueId } from '@/lib/session';
import { NotConnected } from '@/components/NotConnected';
import { LeaguePicker } from '@/components/LeaguePicker';
import { listMyLeagues } from '@/app/actions/leagues';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function MiniLeague() {
  const managerId = getManagerId();
  if (!managerId) return <NotConnected where="Mini League War Room" />;

  const leagues = await listMyLeagues();
  const activeId = getLeagueId();
  // If no league cookie set but we have leagues, default to the user's
  // highest-ranked classic league so the page renders something useful.
  const leagueId = activeId
    ?? leagues.find(l => l.scoring === 'c' && !l.closed)?.leagueId
    ?? leagues[0]?.leagueId
    ?? null;

  const gw = await currentGameweek();
  if (!gw) return <p className="text-ink-muted">No gameweek data yet — hit Refresh.</p>;

  if (!leagueId) {
    return (
      <div className="space-y-4">
        <header>
          <div className="text-xs uppercase tracking-widest text-ink-dim">Mini league war room</div>
          <h1 className="text-2xl font-semibold">No leagues yet</h1>
        </header>
        <Card title="No leagues found">
          <p className="text-sm text-ink-muted">
            Hit <span className="font-mono">Refresh now</span> to auto-pull your
            FPL leagues, or run <span className="font-mono">db:seed</span> locally.
          </p>
        </Card>
      </div>
    );
  }

  const active = leagues.find(l => l.leagueId === leagueId);
  const wr: any = await buildWarRoom(leagueId, managerId, gw.id);
  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-xs uppercase tracking-widest text-ink-dim">Mini league war room</div>
          <h1 className="text-2xl font-semibold">
            {active?.name ?? `League ${leagueId}`} · {gw.name}
          </h1>
          {active && (
            <div className="flex gap-2 mt-2 text-xs">
              {active.entryRank && <Badge tone="blue">your rank #{active.entryRank}</Badge>}
              {active.entryLastRank && active.entryRank && (
                <Badge tone={active.entryRank < active.entryLastRank ? 'green' : 'amber'}>
                  {active.entryRank < active.entryLastRank ? '↑' : '↓'} from #{active.entryLastRank}
                </Badge>
              )}
              <Badge tone="steel">{active.scoring === 'h' ? 'H2H' : 'classic'}</Badge>
            </div>
          )}
        </div>
        <LeaguePicker leagues={leagues} activeLeagueId={leagueId} />
      </header>

      {wr.empty ? (
        <Card title="No standings yet">
          <p className="text-sm text-ink-muted">{wr.message}</p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Threats" subtitle="High-EO rivals own, you don't">
              <Table>
                <THead><TH>Player</TH><TH>Team</TH><TH className="text-right">EO</TH><TH className="text-right">xPts</TH></THead>
                <tbody>
                  {wr.threats.map((t: any) => (
                    <TR key={t.playerId}>
                      <TD className="font-semibold">{t.webName}</TD>
                      <TD>{t.teamShort}</TD>
                      <TD className="text-right font-mono">{Number(t.eo).toFixed(0)}%</TD>
                      <TD className="text-right font-mono">{Number(t.projection).toFixed(2)}</TD>
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
                      <TD className="text-right font-mono">{Number(h.eo).toFixed(0)}%</TD>
                      <TD className="text-right font-mono">{Number(h.projection).toFixed(2)}</TD>
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
                    <TD className="text-right font-mono">{Number(c.cappedByPct).toFixed(0)}%</TD>
                    <TD className="text-right font-mono">{Number(c.projection).toFixed(2)}</TD>
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
        </>
      )}

      <Card title="All my leagues" subtitle="Auto-pulled from FPL on every refresh">
        <Table>
          <THead>
            <TH>League</TH>
            <TH className="text-right">Rank</TH>
            <TH className="text-right">Δ</TH>
            <TH>Type</TH>
            <TH>{' '}</TH>
          </THead>
          <tbody>
            {leagues.map(l => {
              const delta = (l.entryRank != null && l.entryLastRank != null)
                ? l.entryLastRank - l.entryRank
                : null;
              return (
                <TR key={l.leagueId}>
                  <TD className="font-semibold">{l.name}</TD>
                  <TD className="text-right font-mono">{l.entryRank ?? '—'}</TD>
                  <TD className={`text-right font-mono ${
                    delta == null ? '' : delta > 0 ? 'text-accent-green' : delta < 0 ? 'text-accent-red' : 'text-ink-dim'
                  }`}>
                    {delta == null ? '—' : delta > 0 ? `+${delta}` : `${delta}`}
                  </TD>
                  <TD className="text-xs text-ink-muted">{l.scoring === 'h' ? 'H2H' : 'classic'}</TD>
                  <TD>{l.leagueId === leagueId && <Badge tone="green">active</Badge>}</TD>
                </TR>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
