import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';
import { evaluatePicks, rollupToLeaderboard } from '@/lib/signals/accuracy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Creator accuracy leaderboard.
 *
 * Every creator_rankings row whose target GW is finished is replayed against
 * the actual points scored, and a beat-the-median rate per creator per
 * ranking_kind is shown. Sub-5-pick rows are pushed to the bottom and styled
 * down so the user doesn't read tiny samples as signal.
 *
 * The page is read-only — no actions, no caching beyond Next's RSC dedupe.
 * Run the ingest script enough to seed creator_rankings, then come back here.
 */
export default async function CreatorAccuracy() {
  const evals = await evaluatePicks(2000);
  const leaderboard = rollupToLeaderboard(evals);

  // Per-creator overall row for the top-of-page summary card.
  const byCreator = new Map<string, { name: string; total: number; wins: number; sum: number }>();
  for (const e of evals) {
    if (!byCreator.has(e.channelId)) {
      byCreator.set(e.channelId, { name: e.channelName, total: 0, wins: 0, sum: 0 });
    }
    const b = byCreator.get(e.channelId)!;
    b.total += 1;
    if (e.beatMedian) b.wins += 1;
    const signed = e.rankingKind === 'avoid'
      ? (e.positionMedianPoints - e.playerPoints)
      : (e.playerPoints - e.positionMedianPoints);
    b.sum += signed;
  }
  const creatorSummary = Array.from(byCreator.entries())
    .map(([id, b]) => ({
      channelId: id,
      channelName: b.name,
      totalPicks: b.total,
      beatRate: b.total === 0 ? 0 : b.wins / b.total,
      avgAbove: b.total === 0 ? 0 : b.sum / b.total
    }))
    .sort((a, b) => b.beatRate - a.beatRate);

  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Creator board</div>
        <h1 className="text-2xl font-semibold">Accuracy leaderboard</h1>
        <p className="text-sm text-ink-muted mt-1 max-w-2xl">
          Every ordered ranking pulled from a creator&apos;s video is replayed against
          the actual points scored over the next 1–4 gameweeks (depending on the
          ranking kind). The score is the rate at which their pick beat the
          position-level median over the same window. Small samples (&lt; 5 picks)
          are pushed to the bottom and faded — treat them as &ldquo;not yet enough
          data&rdquo; rather than evidence.
        </p>
      </header>

      <Card title="Overall by creator" subtitle="All ranking kinds combined.">
        {creatorSummary.length === 0 ? (
          <EmptyState />
        ) : (
          <Table>
            <THead>
              <TH>Creator</TH>
              <TH className="text-right">Picks evaluated</TH>
              <TH className="text-right">Beat median</TH>
              <TH className="text-right">Avg pts above median</TH>
            </THead>
            <tbody>
              {creatorSummary.map(c => (
                <TR key={c.channelId}>
                  <TD>{c.channelName}</TD>
                  <TD className="text-right font-mono">{c.totalPicks}</TD>
                  <TD className="text-right font-mono">
                    {(c.beatRate * 100).toFixed(0)}%
                  </TD>
                  <TD className={`text-right font-mono ${c.avgAbove >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                    {c.avgAbove >= 0 ? '+' : ''}{c.avgAbove.toFixed(2)}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card
        title="By creator × ranking kind"
        subtitle="Captains, transfers in / out, differentials, set-and-forget, avoid."
      >
        {leaderboard.length === 0 ? (
          <EmptyState />
        ) : (
          <Table>
            <THead>
              <TH>Creator</TH>
              <TH>Ranking</TH>
              <TH className="text-right">N picks</TH>
              <TH className="text-right">Beat median</TH>
              <TH className="text-right">Avg pts above</TH>
              <TH className="text-right">Last GW</TH>
            </THead>
            <tbody>
              {leaderboard.map(row => {
                const small = row.totalPicks < 5;
                return (
                  <TR key={`${row.channelId}-${row.rankingKind}`} className={small ? 'opacity-40' : ''}>
                    <TD>{row.channelName}</TD>
                    <TD>
                      <Badge tone={kindTone(row.rankingKind)}>{row.rankingKind.replace(/_/g, ' ')}</Badge>
                    </TD>
                    <TD className="text-right font-mono">{row.totalPicks}</TD>
                    <TD className="text-right font-mono">
                      <span className={
                        small ? '' :
                        row.beatMedianRate >= 0.6 ? 'text-accent-green' :
                        row.beatMedianRate >= 0.45 ? 'text-ink' :
                        'text-accent-red'
                      }>
                        {(row.beatMedianRate * 100).toFixed(0)}%
                      </span>
                      <span className="text-ink-dim ml-1">({row.beatMedianPicks}/{row.totalPicks})</span>
                    </TD>
                    <TD className={`text-right font-mono ${row.avgPointsAboveMedian >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                      {row.avgPointsAboveMedian >= 0 ? '+' : ''}{row.avgPointsAboveMedian.toFixed(2)}
                    </TD>
                    <TD className="text-right font-mono text-ink-dim">{row.lastEvaluatedGw ?? '—'}</TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="How this is computed">
        <p className="text-sm text-ink-muted">
          For each ranking row, we sum the player&apos;s <code>total_points</code> over
          a window forward of the target gameweek — 1 GW for captains, 3 GW for
          transfers in/out and differentials, 4 GW for set-and-forget. Their pick
          &ldquo;beat the median&rdquo; if that sum is greater than the median of every other
          active player at the same position over the same window. <code>avoid</code>{' '}
          inverts the comparison — a successful avoid means the player scored
          BELOW the median. All inputs are read from{' '}
          <code>player_gameweek_history</code> + <code>players</code>; no
          model output is consulted, so this number is independent of our own
          projections and provides a fair external benchmark.
        </p>
      </Card>
    </div>
  );
}

function EmptyState() {
  return (
    <p className="text-sm text-ink-muted">
      No evaluable rankings yet — either no rankings have been extracted, or
      none of the target gameweeks have finished. Run{' '}
      <span className="font-mono">npm run ingest:youtube</span> over several
      weeks to build up history.
    </p>
  );
}

function kindTone(kind: string): 'green' | 'red' | 'amber' | 'blue' | 'violet' | 'steel' {
  switch (kind) {
    case 'captains':       return 'violet';
    case 'transfers_in':   return 'green';
    case 'transfers_out':  return 'red';
    case 'differentials':  return 'blue';
    case 'set_and_forget': return 'amber';
    case 'avoid':          return 'red';
    default:               return 'steel';
  }
}
