import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { sql } from '@/lib/db/client';
import { getManagerId } from '@/lib/session';
import { getDecisionMatrix, type DecisionMatrixEntry } from '@/lib/signals/decision-matrix';
import { fmt } from '@/lib/util/fmt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Decision Matrix — the 4-quadrant buy/sell board.
 *
 * Each card surfaces one player. The quadrant tells you the consensus
 * picture (creators agreeing with the model, disagreeing, etc) and the
 * card's top-quote tells you why. Owned players are flagged so you can
 * spot when the matrix is telling you to act on YOUR squad rather than
 * a generic "everyone should buy" pick.
 */
export default async function DecisionMatrixPage() {
  // Same gameweek resolution the Creator Board uses: next un-deadlined GW,
  // fall back to current. Anonymous users still get a useful (non-owned)
  // view of the matrix.
  const gwRows = await sql<Array<{ id: number }>>`
    SELECT id FROM gameweeks
     WHERE deadline_time > now()
     ORDER BY deadline_time ASC
     LIMIT 1
  `;
  let startGw = gwRows[0]?.id;
  if (!startGw) {
    const cur = await sql<Array<{ id: number }>>`
      SELECT id FROM gameweeks WHERE is_current = TRUE LIMIT 1
    `;
    startGw = cur[0]?.id;
  }
  if (!startGw) {
    return (
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold">Decision Matrix</h1>
        </header>
        <p className="text-ink-muted">No upcoming gameweek to score against — try again after the next deadline is set.</p>
      </div>
    );
  }

  const managerId = getManagerId();
  const matrix = await getDecisionMatrix(managerId, startGw);

  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Decision matrix</div>
        <h1 className="text-2xl font-semibold">Buy / sell board · GW{startGw}</h1>
        <p className="text-sm text-ink-muted mt-1 max-w-3xl">
          Pending creator signals × model verdict, bucketed into the four
          actionable cells. Where creators and the model agree, the call is
          cleanest. Where they disagree, decide who you trust on this
          specific player. The fifth panel surfaces high-xPts players the
          creator pool hasn&apos;t mentioned yet.
        </p>
      </header>

      {/* Top row: strong picks */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <QuadrantCard
          title="Strong BUYs"
          subtitle="Creators say buy. Model agrees."
          tone="green"
          rows={matrix.strongBuys}
          emptyText="No consensus buys this week."
        />
        <QuadrantCard
          title="Strong SELLs"
          subtitle="Creators say sell. Model agrees."
          tone="red"
          rows={matrix.strongSells}
          emptyText="No consensus sells this week."
        />
      </div>

      {/* Middle row: disagreements — these are the interesting ones */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <QuadrantCard
          title="Expert edge"
          subtitle="Creators want to buy. Model disagrees. Are they seeing something the model isn't?"
          tone="amber"
          rows={matrix.expertEdge}
          emptyText="No expert-only buys."
        />
        <QuadrantCard
          title="Model edge"
          subtitle="Creators want to sell. Model disagrees — we say hold. Bargain ahead?"
          tone="blue"
          rows={matrix.modelEdge}
          emptyText="No model-only holds."
        />
      </div>

      {/* Bottom row: blind spots */}
      <Card
        title="Model's blind spots"
        subtitle="Top players by 3-GW xPts that nobody on the creator board is talking about."
      >
        <QuadrantBody rows={matrix.blindSpots} emptyText="No blind spots — every top-xPts player is on the creator board." hideCreator />
      </Card>

      <Card title="How this is built">
        <p className="text-sm text-ink-muted">
          Every pending signal on the Creator Board is bucketed by signal kind
          (buying / recommend → BUY side; selling / bench → SELL side) and
          cross-referenced against the model verdict (top quartile by 3-GW
          xPts at the player&apos;s position). Multiple signals on the same
          player from different creators roll up into one card; the most
          confident quote is shown. Blind spots are computed as top-30 xPts
          players who didn&apos;t appear in the signal join. No creator
          opinion is treated as fact — accept on the Creator Board to feed
          it into the manual-override chain.
        </p>
      </Card>
    </div>
  );
}

interface QuadrantCardProps {
  title: string;
  subtitle: string;
  tone: 'green' | 'red' | 'amber' | 'blue';
  rows: DecisionMatrixEntry[];
  emptyText: string;
}

function QuadrantCard({ title, subtitle, tone, rows, emptyText }: QuadrantCardProps) {
  return (
    <Card title={title} subtitle={subtitle}>
      <div className="flex items-center gap-2 mb-3 text-[11px]">
        <Badge tone={tone}>{rows.length} {rows.length === 1 ? 'player' : 'players'}</Badge>
      </div>
      <QuadrantBody rows={rows} emptyText={emptyText} />
    </Card>
  );
}

function QuadrantBody({
  rows, emptyText, hideCreator = false
}: { rows: DecisionMatrixEntry[]; emptyText: string; hideCreator?: boolean }) {
  if (rows.length === 0) {
    return <p className="text-sm text-ink-muted italic">{emptyText}</p>;
  }
  return (
    <ul className="divide-y divide-line">
      {rows.map(r => (
        <li key={r.playerId} className="py-2">
          <DecisionRow r={r} hideCreator={hideCreator} />
        </li>
      ))}
    </ul>
  );
}

function DecisionRow({ r, hideCreator }: { r: DecisionMatrixEntry; hideCreator: boolean }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2 flex-wrap">
        <div className="font-medium">{r.webName}</div>
        <span className="text-[10px] font-mono text-ink-dim">
          {r.position} · {r.teamShort} · £{(r.nowCost / 10).toFixed(1)}m
        </span>
        {r.owned && <Badge tone="blue">in squad</Badge>}
        {!hideCreator && r.creatorNames.length >= 2 && (
          <Badge tone="violet">{r.creatorNames.length}× consensus</Badge>
        )}
        <span className="ml-auto text-[11px] font-mono">
          <span className="text-ink-muted">3-GW</span>{' '}
          <span className="text-ink">{fmt(r.xpts3, 1)}</span>
          {r.positionCount > 0 && (
            <span className="text-ink-dim ml-1">
              · #{r.positionRank}/{r.positionCount} {r.position}
            </span>
          )}
        </span>
      </div>
      {!hideCreator && r.signalKinds.length > 0 && (
        <div className="flex flex-wrap gap-1 text-[10px]">
          {r.signalKinds.map(k => (
            <Badge key={k} tone="steel">{k}</Badge>
          ))}
          <span className="text-ink-dim ml-1">
            via {r.creatorNames.join(', ')}
          </span>
        </div>
      )}
      {!hideCreator && r.topQuote && (
        <blockquote className="text-xs italic text-ink-muted border-l-2 border-line pl-2">
          &ldquo;{r.topQuote.text}&rdquo;
          <a
            href={r.topQuote.url}
            target="_blank" rel="noopener noreferrer"
            className="ml-1 text-accent-blue hover:underline not-italic"
          >
            — {r.topQuote.channel} @ {fmtTs(r.topQuote.ts)} ↗
          </a>
        </blockquote>
      )}
    </div>
  );
}

function fmtTs(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
