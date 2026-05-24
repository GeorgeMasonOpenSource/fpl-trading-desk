/**
 * Press Conferences — Team News, GW-focused.
 *
 * Per team:
 *   • Header  — team, manager, table position, fixture, motivation tag
 *   • Predicted XI — 11 players, legal formation, expected minutes
 *   • Out / Doubts (%) / Banned — three structured columns, active
 *     squad only (transfers-out filtered)
 *   • Latest News — synthesised paragraph leading with manager-attributed
 *     creator quotes (when present) then engine takeaways
 *   • Manager said — verbatim creator quotes that explicitly mention
 *     the team's manager surname (Pep / Arteta / Carrick / Slot / etc.)
 *     with timestamped video links
 *   • Pundit chatter — every other creator quote (separated so the user
 *     sees what's actual presser reporting vs creator opinion)
 *
 * Plus a global Rotation Watchlist at the top.
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

  // Alphabetical by team short name.
  teamSummaries.sort((a, b) => a.teamShort.localeCompare(b.teamShort));

  const totalManagerQuotes = teamSummaries.reduce((s, t) => s + t.managerQuotes.length, 0);
  const totalPunditQuotes  = teamSummaries.reduce((s, t) => s + t.punditQuotes.length, 0);
  const dataFreshness =
    totalManagerQuotes > 0
      ? `${totalManagerQuotes} manager-attributed quotes · ${totalPunditQuotes} pundit comments (last 48h)`
      : totalPunditQuotes > 0
        ? `${totalPunditQuotes} pundit comments (last 48h) · no quotes citing managers directly`
        : 'No creator signals in last 48h — engine projections + FPL flags only';
  const deadline = gw.deadline_time ? formatRelative(gw.deadline_time) : '';

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{gw.name} · Team News</h1>
          <p className="text-ink-muted text-sm mt-1">
            Predicted XI, injury / suspension / doubt status, and a synthesised press-conference
            summary for every PL team. We surface creator quotes that explicitly cite the manager
            (Pep, Arteta, Carrick, etc.) in a separate panel so you can see what was actually said
            vs creator opinion. Off-season transfers and rest-of-season loans are filtered out.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {deadline && <Badge tone="blue">Deadline {deadline}</Badge>}
          <Badge tone={totalManagerQuotes > 0 ? 'green' : totalPunditQuotes > 0 ? 'amber' : 'steel'}>
            {dataFreshness}
          </Badge>
        </div>
      </header>

      <RotationWatchlist list={watchlist} />

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-semibold">Team-by-team</h2>
          <span className="text-xs text-ink-dim">Alphabetical</span>
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
          No meaningful rotation signals for this GW.
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
          {severe.length} severe · {moderate.length} moderate · {mild.length} mild
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
    c.severity === 'moderate' ? 'text-accent-amber' : 'text-ink-muted';
  const sevDot =
    c.severity === 'severe' ? 'bg-accent-red' :
    c.severity === 'moderate' ? 'bg-accent-amber' : 'bg-ink-dim';
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
    </li>
  );
}

// ─── Team card ────────────────────────────────────────────────────────────────

function TeamCard({ team }: { team: TeamPressSummary }) {
  const motivationTone =
    team.motivation == null   ? 'steel' :
    team.motivation >= 0.7    ? 'green' :
    team.motivation >= 0.4    ? 'amber' : 'red';
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
            {team.managerName && (
              <p className="text-[11px] text-ink-dim mt-0.5">Manager: {team.managerName}</p>
            )}
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

        <Section title="Predicted XI">
          <ul className="grid grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-1.5 mt-1">
            {team.predictedXI.starters.map(p => <XIRow key={p.playerId} p={p} />)}
          </ul>
        </Section>

        <div className="grid grid-cols-3 gap-3">
          <BucketCol title="Out" tone="red" players={team.out} emptyText="—" />
          <BucketCol title="Doubts" tone="amber" players={team.doubts} emptyText="—"
                     formatRight={l => l.chanceOfPlayingNext != null ? `${l.chanceOfPlayingNext}%` : '?'} />
          <BucketCol title="Banned" tone="red" players={team.banned} emptyText="—" />
        </div>

        {team.externalNews?.latestNews && (
          <Section title={`From ${team.externalNews.sourceLabel}`}>
            <p className="text-xs text-ink leading-relaxed">{team.externalNews.latestNews}</p>
            <p className="text-[10px] text-ink-dim mt-1">
              {team.externalNews.lastUpdated && <>Last updated {team.externalNews.lastUpdated} · </>}
              <a href={team.externalNews.sourceUrl} target="_blank" rel="noopener noreferrer"
                 className="text-accent-blue hover:underline">
                Source: {team.externalNews.sourceLabel}↗
              </a>
            </p>
            {(team.externalNews.out.length + team.externalNews.doubts.length + team.externalNews.banned.length) > 0 && (
              <div className="grid grid-cols-3 gap-3 mt-2 text-[11px]">
                <ExternalList title="Out" items={team.externalNews.out.map(i => i.name)} tone="red" />
                <ExternalList title="Doubts" items={team.externalNews.doubts.map(d => d.percent != null ? `${d.name} (${d.percent}%)` : d.name)} tone="amber" />
                <ExternalList title="Banned" items={team.externalNews.banned.map(i => i.name)} tone="red" />
              </div>
            )}
          </Section>
        )}

        <Section title={team.externalNews?.latestNews ? 'Engine summary' : 'Latest news'}>
          <p className="text-xs text-ink leading-relaxed">{team.latestNews}</p>
          {team.newsUpdatedAt && (
            <p className="text-[10px] text-ink-dim mt-1">
              Newest quote {ageOfQuote(team.newsUpdatedAt)} ·{' '}
              {team.managerQuotes.length} manager-attributed ·{' '}
              {team.punditQuotes.length} other
            </p>
          )}
        </Section>

        {team.managerQuotes.length > 0 && (
          <Section title={team.managerName ? `What ${team.managerName} said (via creators)` : 'Manager-attributed quotes'}>
            <ul className="space-y-1.5 mt-1">
              {team.managerQuotes.map((q, i) => (
                <li key={i}><QuoteLine q={q} /></li>
              ))}
            </ul>
          </Section>
        )}

        {team.punditQuotes.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-ink-muted hover:text-ink select-none">
              Pundit chatter ({team.punditQuotes.length})
              <span className="text-ink-dim ml-2">— creator analysis not citing the manager</span>
            </summary>
            <ul className="space-y-1.5 mt-2 pl-2 border-l border-line">
              {team.punditQuotes.map((q, i) => (
                <li key={i}><QuoteLine q={q} /></li>
              ))}
            </ul>
          </details>
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

function ExternalList({ title, items, tone }: { title: string; items: string[]; tone: 'red' | 'amber' }) {
  const dot = tone === 'red' ? 'bg-accent-red' : 'bg-accent-amber';
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden />
        <h5 className="text-[10px] uppercase tracking-widest text-ink-dim font-semibold">{title}</h5>
      </div>
      {items.length === 0
        ? <p className="text-[11px] text-ink-dim">—</p>
        : <ul className="space-y-0.5">{items.map((it, i) => <li key={i} className="text-[11px]">{it}</li>)}</ul>
      }
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
  const quote = q.rawQuote.length > 200 ? q.rawQuote.slice(0, 200) + '…' : q.rawQuote;
  return (
    <p className="text-[11px] text-ink-muted italic leading-snug">
      <span className={`not-italic font-mono ${tagDot}`}>[{tagLabel}]</span>{' '}
      <span className="text-ink-dim not-italic">
        {q.channelName} · {ageOfQuote(q.publishedAt)}
        {q.mentionsManager && <span className="text-accent-green"> · cites mgr</span>}
      </span>{' '}
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
