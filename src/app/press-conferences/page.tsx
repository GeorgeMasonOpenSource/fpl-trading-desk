/**
 * Press Conferences — Team News brief.
 *
 * For the upcoming GW, every PL team gets a card with:
 *
 *   1. Fixture (opponent + H/A) and motivation context
 *   2. Predicted XI — 11 players in legal-formation order, with expected
 *      minutes per player
 *   3. Out / Doubts (% chance) / Banned — three structured columns
 *   4. Latest News — a 2-4 sentence narrative paragraph synthesised
 *      from the last-48h creator transcripts + FPL flags + engine
 *      projections + motivation context
 *   5. Source quotes — expandable list of the verbatim transcript snippets
 *      from FPL pundit videos that informed the narrative, each linked
 *      to the source video at the right timestamp
 *
 * Plus a global Rotation Watchlist at the top — top-N players where
 * expected minutes are below their season average, ranked by impact.
 */
import { sql } from '@/lib/db/client';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import {
  buildPressConferenceSummary,
  buildRotationWatchlist,
  type TeamPressSummary,
  type PressPlayerLine,
  type PressQuote,
  type RotationCandidate,
} from '@/lib/signals/press-conferences';

export const runtime  = 'nodejs';
export const dynamic  = 'force-dynamic';

export default async function PressConferencesPage() {
  const gwRows = await sql<Array<{ id: number; name: string; deadline_time: string | null }>>`
    SELECT id, name, deadline_time::text AS deadline_time
    FROM gameweeks
    WHERE is_next = TRUE OR is_current = TRUE OR finished = FALSE
    ORDER BY is_next DESC, is_current DESC, id ASC
    LIMIT 1
  `;
  const gw = gwRows[0];
  if (!gw) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Team News</h1>
        <p className="text-ink-muted">No upcoming gameweek found — run db:seed.</p>
      </div>
    );
  }

  const [watchlist, teamSummaries] = await Promise.all([
    buildRotationWatchlist(gw.id, { withinHours: 48, limit: 25 }),
    buildPressConferenceSummary(gw.id, { withinHours: 48 }),
  ]);

  // Sort: most actionable first (bans > outs > doubts > rotation > settled).
  teamSummaries.sort((a, b) => {
    const aRisk = a.banned.length * 20 + a.out.length * 8 + a.doubts.length * 3;
    const bRisk = b.banned.length * 20 + b.out.length * 8 + b.doubts.length * 3;
    if (bRisk !== aRisk) return bRisk - aRisk;
    return a.teamShort.localeCompare(b.teamShort);
  });

  const totalQuotes = teamSummaries.reduce((s, t) => s + t.teamLevelQuotes.length, 0);
  const dataFreshness = totalQuotes > 0
    ? `${totalQuotes} creator signals (last 48h)`
    : 'No creator signals in last 48h — engine projections only';
  const deadline = gw.deadline_time ? formatRelative(gw.deadline_time) : '';

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{gw.name} · Team News</h1>
          <p className="text-ink-muted text-sm mt-1">
            Predicted XI, injury/suspension lists, and a synthesised press-conf
            summary for every PL team. Pulls from FPL bootstrap, our minutes
            engine, and creator-transcript signals from the last 48h.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {deadline && <Badge tone="blue">Deadline {deadline}</Badge>}
          <Badge tone={totalQuotes > 0 ? 'steel' : 'amber'}>{dataFreshness}</Badge>
        </div>
      </header>

      <RotationWatchlist list={watchlist} />

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-semibold">Team-by-team</h2>
          <span className="text-xs text-ink-dim">Sorted by GW disruption</span>
        </div>
        <div className="space-y-4">
          {teamSummaries.map(t => <TeamCard key={t.teamId} team={t} />)}
        </div>
      </section>
    </div>
  );
}

// ─── Rotation watchlist ─────────────────────────────────────────────────────

function RotationWatchlist({ list }: { list: RotationCandidate[] }) {
  if (list.length === 0) {
    return (
      <Card>
        <h2 className="text-lg font-semibold">Rotation watchlist</h2>
        <p className="text-sm text-ink-muted mt-2">
          No meaningful rotation signals for this GW — engine projections
          align with every player&apos;s season average.
        </p>
      </Card>
    );
  }
  const severe = list.filter(c => c.severity === 'severe');
  const moderate = list.filter(c => c.severity === 'moderate');
  const mild = list.filter(c => c.severity === 'mild');
  return (
    <Card>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-semibold">Rotation watchlist</h2>
        <span className="text-xs text-ink-dim">
          {severe.length} severe · {moderate.length} moderate · {mild.length} mild · sorted by impact
        </span>
      </div>
      <ul className="divide-y divide-line">
        {list.map(c => <WatchlistRow key={c.playerId} c={c} />)}
      </ul>
    </Card>
  );
}

function WatchlistRow({ c }: { c: RotationCandidate }) {
  const sevColour =
    c.severity === 'severe' ? 'text-accent-red' :
    c.severity === 'moderate' ? 'text-accent-amber' :
                                 'text-ink-muted';
  const sevDot =
    c.severity === 'severe' ? 'bg-accent-red' :
    c.severity === 'moderate' ? 'bg-accent-amber' :
                                 'bg-ink-dim';
  const deltaSign = c.minsDeltaVsSeason >= 0 ? '+' : '';
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${sevDot}`} aria-hidden />
          <span className="font-semibold">{c.webName}</span>
          <span className="text-xs text-ink-dim">{c.teamShort} · {c.position} · £{(c.cost / 10).toFixed(1)}m</span>
        </div>
        <div className="flex items-baseline gap-3 font-mono text-xs">
          <span>{Math.round(c.expectedMinutes)}'</span>
          <span className="text-ink-dim">/ {Math.round(c.seasonAvgMinsPerApp)}' avg</span>
          <span className={sevColour}>{deltaSign}{Math.round(c.minsDeltaVsSeason)}'</span>
          <span className="text-ink-muted">{Math.round(c.startProb * 100)}% start</span>
        </div>
      </div>
      {c.reasons.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {c.reasons.map((r, i) => (
            <li key={i} className="text-xs text-ink-muted">→ {r}</li>
          ))}
        </ul>
      )}
      {c.freshQuotes.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {c.freshQuotes.map((q, i) => (
            <li key={i} className="text-[11px] text-ink-muted">
              <span className="text-ink-dim">{q.channelName} · {ageOfQuote(q.publishedAt)} · </span>
              <a href={q.videoUrl} target="_blank" rel="noopener noreferrer"
                 className="text-accent-blue hover:underline">video↗</a>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

// ─── Team card (FFS-style) ────────────────────────────────────────────────────

function TeamCard({ team }: { team: TeamPressSummary }) {
  const motivationTone =
    team.motivation == null   ? 'steel' :
    team.motivation >= 0.7    ? 'green' :
    team.motivation >= 0.4    ? 'amber' :
                                'red';
  const f = team.predictedXI.formation;
  return (
    <Card>
      <div className="space-y-3">
        <header className="flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-base font-semibold">
              {team.teamShort}
              {team.tablePosition != null && (
                <span className="text-xs text-ink-dim font-normal ml-2">
                  #{team.tablePosition} · {team.teamName}
                </span>
              )}
            </h3>
            <p className="text-xs text-ink-muted mt-0.5">
              <span className="font-medium">Next match:</span> {team.fixtureSummary}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Badge tone={motivationTone as any} title={`motivation_score ${team.motivation ?? '?'}`}>
              {team.motivationLabel}
            </Badge>
            <span className="text-[10px] text-ink-dim font-mono">
              Predicted: {f.def}-{f.mid}-{f.fwd}
            </span>
          </div>
        </header>

        {/* Predicted XI grid */}
        <Section title="Predicted XI">
          <ul className="grid grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-1.5 mt-1">
            {team.predictedXI.starters.map(p => <XIRow key={p.playerId} p={p} />)}
          </ul>
        </Section>

        {/* Out / Doubts / Banned columns */}
        <div className="grid grid-cols-3 gap-3">
          <BucketCol title="Out" tone="red" players={team.out} emptyText="—" />
          <BucketCol title="Doubts" tone="amber" players={team.doubts} emptyText="—"
                     formatRight={l => l.chanceOfPlayingNext != null ? `${l.chanceOfPlayingNext}%` : '?'} />
          <BucketCol title="Banned" tone="red" players={team.banned} emptyText="—" />
        </div>

        {/* Latest News narrative */}
        <Section title="Latest news">
          <p className="text-xs text-ink leading-relaxed">{team.latestNews}</p>
          {team.newsUpdatedAt && (
            <p className="text-[10px] text-ink-dim mt-1">
              Newest quote {ageOfQuote(team.newsUpdatedAt)} · {team.teamLevelQuotes.length} sources in window
            </p>
          )}
        </Section>

        {/* Source quotes (verifiable) */}
        {team.teamLevelQuotes.length > 0 && (
          <Section title="Source quotes (last 48h)">
            <ul className="space-y-1.5 mt-1">
              {team.teamLevelQuotes.slice(0, 6).map((q, i) => (
                <li key={i}>
                  <QuoteLine q={q} />
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </Card>
  );
}

function XIRow({ p }: { p: PressPlayerLine }) {
  const mins = Math.round(p.expectedMinutes ?? 0);
  const minsTone =
    mins >= 80 ? 'text-ink' :
    mins >= 60 ? 'text-ink-muted' :
                 'text-accent-amber';
  return (
    <li className="flex items-baseline justify-between gap-2 text-xs">
      <span>
        <span className="text-ink-dim font-mono text-[10px]">{p.position}</span>{' '}
        <span className="font-medium">{p.webName}</span>
      </span>
      <span className={`font-mono text-[11px] ${minsTone}`}>{mins}'</span>
    </li>
  );
}

function BucketCol({
  title, tone, players, emptyText, formatRight,
}: {
  title: string;
  tone: 'red' | 'amber';
  players: PressPlayerLine[];
  emptyText?: string;
  formatRight?: (l: PressPlayerLine) => string;
}) {
  const dot = tone === 'red' ? 'bg-accent-red' : 'bg-accent-amber';
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden />
        <h4 className="text-[10px] uppercase tracking-widest text-ink-dim font-semibold">{title}</h4>
      </div>
      {players.length === 0 ? (
        <p className="text-xs text-ink-dim">{emptyText ?? '—'}</p>
      ) : (
        <ul className="space-y-1">
          {players.map(p => (
            <li key={p.playerId} className="text-xs flex items-baseline justify-between gap-2">
              <span>
                <span className="font-medium">{p.webName}</span>
                {p.news && (
                  <span className="text-[10px] text-ink-dim block leading-tight">
                    {truncate(p.news, 60)}
                  </span>
                )}
              </span>
              {formatRight && (
                <span className="font-mono text-[11px] text-ink-muted shrink-0">{formatRight(p)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <h4 className="text-[10px] uppercase tracking-widest text-ink-dim font-semibold">{title}</h4>
      {children}
    </div>
  );
}

function QuoteLine({ q }: { q: PressQuote }) {
  const tagDot =
    q.signalKind === 'start' ? 'text-accent-green' :
    q.signalKind === 'bench' ? 'text-accent-amber' :
                                'text-accent-red';
  const tagLabel =
    q.signalKind === 'start' ? 'start' :
    q.signalKind === 'bench' ? 'bench' :
                                'injury';
  const quote = q.rawQuote.length > 180 ? q.rawQuote.slice(0, 180) + '…' : q.rawQuote;
  return (
    <p className="text-[11px] text-ink-muted italic leading-snug">
      <span className={`not-italic font-mono ${tagDot}`}>[{tagLabel}]</span>{' '}
      <span className="text-ink-dim">{q.channelName} · {ageOfQuote(q.publishedAt)}</span>{' '}
      “{quote}”{' '}
      <a href={q.videoUrl} target="_blank" rel="noopener noreferrer"
         className="text-accent-blue hover:underline not-italic">video↗</a>
    </p>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

function ageOfQuote(publishedAt: string): string {
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return '';
  const mins = (Date.now() - t) / 60000;
  if (mins < 60) return `${Math.round(mins)}m ago`;
  const hrs = mins / 60;
  if (hrs < 24) return `${Math.round(hrs)}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diffMs = t - Date.now();
  if (diffMs < 0) return 'passed';
  const hrs = diffMs / 3_600_000;
  if (hrs < 1) return `in ${Math.max(1, Math.round(hrs * 60))}m`;
  if (hrs < 24) return `in ${hrs.toFixed(1)}h`;
  return `in ${Math.round(hrs / 24)}d`;
}
