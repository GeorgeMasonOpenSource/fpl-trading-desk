import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { getCreatorLineups, type CreatorLineup, type LineupPlayer } from '@/lib/signals/creator-lineups';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Creator Lineups — one card per FPL creator showing their predicted
 * starting XI, captain, bench, and transfers in/out for the planning
 * gameweek, all assembled from their most recent video.
 *
 * Useful for "what are the creators doing this week" at a glance without
 * scrolling through 16 individual signals per creator on the Creator Board.
 */
export default async function CreatorLineupsPage() {
  const lineups = await getCreatorLineups();

  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Creator board</div>
        <h1 className="text-2xl font-semibold">Predicted lineups + captains</h1>
        <p className="text-sm text-ink-muted mt-1 max-w-3xl">
          Each card is one FPL creator&apos;s most recent video, parsed into a
          tentative XI / bench / captain / transfers in / transfers out.
          Players come straight from extracted signals — every name is a
          link back to the exact moment in the video where the creator said
          it. Quality is best for creators who follow a clear team-selection
          structure; loose conversational videos will be sparser.
        </p>
      </header>

      {lineups.length === 0 ? (
        <Card title="No lineups yet">
          <p className="text-sm text-ink-muted">
            No transcribed videos in the last 7 days. Run{' '}
            <span className="font-mono">npm run ingest:youtube</span> after the
            next batch of creator videos drops.
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {lineups.map(l => <LineupCard key={l.channelId} lineup={l} />)}
        </div>
      )}
    </div>
  );
}

function LineupCard({ lineup }: { lineup: CreatorLineup }) {
  return (
    <div className="bg-bg-card border border-line rounded-card p-4 space-y-3">
      <header className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <div className="font-semibold text-lg">{lineup.channelName}</div>
          <div className="text-[10px] text-ink-dim font-mono">
            {lineup.publishedAt.slice(0, 10)}
          </div>
        </div>
        <a
          href={lineup.videoUrl}
          target="_blank" rel="noopener noreferrer"
          className="text-xs text-accent-blue hover:underline line-clamp-1"
        >
          {lineup.videoTitle} ↗
        </a>
      </header>

      {/* Captain pick — boxed and prominent because it's the single most
          impactful choice each week. */}
      {lineup.captain && (
        <div className="bg-bg-inset border border-accent-violet/30 rounded-md p-2.5 space-y-1">
          <div className="text-[10px] uppercase tracking-widest text-ink-dim">
            Captain
          </div>
          <div className="flex items-baseline gap-2">
            <a
              href={lineup.captain.videoUrl}
              target="_blank" rel="noopener noreferrer"
              className="font-semibold hover:underline"
            >
              {lineup.captain.webName}
            </a>
            <span className="text-[10px] font-mono text-ink-dim">
              {lineup.captain.position} · {lineup.captain.teamShort}
            </span>
            <Badge tone="violet" className="ml-auto">C</Badge>
          </div>
          <blockquote className="text-[11px] italic text-ink-muted border-l-2 border-line pl-2">
            &ldquo;{lineup.captain.rawQuote}&rdquo;
          </blockquote>
        </div>
      )}

      <LineupSection title="Starting XI" players={lineup.startingXi} tone="green" emptyText="No explicit starters mentioned." />
      <LineupSection title="Bench" players={lineup.bench} tone="steel" emptyText="No bench mentioned." />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <LineupSection title="Transfers in"  players={lineup.transfersIn}  tone="green" emptyText="No transfers in." />
        <LineupSection title="Transfers out" players={lineup.transfersOut} tone="red"   emptyText="No transfers out." />
      </div>
    </div>
  );
}

function LineupSection({
  title, players, tone, emptyText
}: {
  title: string;
  players: LineupPlayer[];
  tone: 'green' | 'red' | 'steel';
  emptyText: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <div className="text-[10px] uppercase tracking-widest text-ink-dim">{title}</div>
        <span className="text-[10px] text-ink-dim font-mono">
          {players.length} player{players.length === 1 ? '' : 's'}
        </span>
      </div>
      {players.length === 0 ? (
        <div className="text-[11px] text-ink-dim italic">{emptyText}</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {players.map(p => <PlayerChip key={`${p.playerId}-${title}`} p={p} tone={tone} />)}
        </div>
      )}
    </div>
  );
}

function PlayerChip({ p, tone }: { p: LineupPlayer; tone: 'green' | 'red' | 'steel' }) {
  // Tooltip carries the verbatim quote so hovering shows full context.
  // The chip itself is a link to the YouTube timestamp.
  const toneClass =
    tone === 'green' ? 'bg-accent-green/15 text-accent-green hover:bg-accent-green/25'
    : tone === 'red'   ? 'bg-accent-red/15   text-accent-red   hover:bg-accent-red/25'
    :                   'bg-line             text-ink-muted   hover:text-ink';
  return (
    <a
      href={p.videoUrl}
      target="_blank" rel="noopener noreferrer"
      title={p.rawQuote}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono transition ${toneClass}`}
    >
      <span className="font-medium">{p.webName}</span>
      <span className="text-ink-dim">{p.position}·{p.teamShort}</span>
    </a>
  );
}
