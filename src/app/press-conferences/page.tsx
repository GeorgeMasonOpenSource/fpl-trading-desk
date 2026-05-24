/**
 * Press Conferences
 *
 * Per-team summary card showing what's actually known about each PL side's
 * GW lineup state, distilled from three sources:
 *   1. FPL bootstrap (status, news, chance_of_playing) — authoritative
 *   2. Minutes engine projections (expected_minutes, start_prob)
 *   3. Creator/transcript signals (start | bench | injury quotes from the
 *      last 7 days of ingested YouTube press-conf / team-news content)
 *
 * Each team card surfaces:
 *   - Nailed starters       — engine + creator concur
 *   - Likely starters       — leaning yes, low rotation risk
 *   - Rotation risk         — could go either way
 *   - Injured / doubtful    — FPL-flagged
 *   - Ruled out by news     — hard-out: suspensions, exits, "not available"
 *
 * Each player line carries the most-informative verbatim creator quote
 * (with timestamped video URL) so the user can verify in 5 seconds.
 *
 * Data freshness: the cron pipeline pulls FPL bootstrap and runs the
 * YouTube transcript ingest every 2 hours. If you've just opened the
 * page after a press conference dropped, give it 5-10 minutes.
 */
import { sql } from '@/lib/db/client';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { buildPressConferenceSummary, type TeamPressSummary, type PressPlayerLine } from '@/lib/signals/press-conferences';

export const runtime  = 'nodejs';
export const dynamic  = 'force-dynamic';

export default async function PressConferencesPage() {
  const gwRows = await sql<Array<{ id: number; name: string }>>`
    SELECT id, name FROM gameweeks
     WHERE is_next = TRUE OR is_current = TRUE OR finished = FALSE
     ORDER BY is_next DESC, is_current DESC, id ASC
     LIMIT 1
  `;
  const gw = gwRows[0];
  if (!gw) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Press Conferences</h1>
        <p className="text-ink-muted">No upcoming gameweek found — run db:seed.</p>
      </div>
    );
  }

  const summary = await buildPressConferenceSummary(gw.id);
  // Sort teams: those with hard-out news or large injury lists first; quiet
  // teams last. Makes the page scan-friendly for triage.
  summary.sort((a, b) => {
    const aRisk = a.ruledOutByNews.length * 10 + a.injured.length + (a.rotationRisk.length >= 4 ? 3 : 0);
    const bRisk = b.ruledOutByNews.length * 10 + b.injured.length + (b.rotationRisk.length >= 4 ? 3 : 0);
    if (bRisk !== aRisk) return bRisk - aRisk;
    return a.teamShort.localeCompare(b.teamShort);
  });

  const totalSignals = summary.reduce((s, t) => s + t.totalSignals, 0);
  const totalRuledOut = summary.reduce((s, t) => s + t.ruledOutByNews.length, 0);
  const totalInjured = summary.reduce((s, t) => s + t.injured.length, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Press Conferences · {gw.name}</h1>
          <p className="text-ink-muted text-sm mt-1">
            Per-team summary distilling FPL news, minutes-engine projections, and creator transcript signals.
            Each player line carries a verbatim quote (where available) timestamped to the source video.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Badge tone="red">{totalRuledOut} ruled out</Badge>
          <Badge tone="amber">{totalInjured} flagged</Badge>
          <Badge tone="steel">{totalSignals} creator signals (last 7d)</Badge>
        </div>
      </div>

      {totalSignals === 0 && (
        <Card>
          <p className="text-sm text-ink-muted">
            No creator-transcript signals in the last 7 days. Cards below fall back to FPL bootstrap data only.
            Run <code className="font-mono text-xs">npm run ingest:youtube</code> to pull recent press-conf content.
          </p>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {summary.map(team => <TeamCard key={team.teamId} team={team} />)}
      </div>
    </div>
  );
}

function TeamCard({ team }: { team: TeamPressSummary }) {
  const showRuledOut = team.ruledOutByNews.length > 0;
  return (
    <Card>
      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <div>
            <h2 className="text-lg font-semibold">{team.teamShort}</h2>
            <p className="text-xs text-ink-dim">{team.teamName}</p>
          </div>
          <div className="text-right">
            <p className="text-xs font-mono text-ink-muted">{team.totalSignals} signals</p>
          </div>
        </div>
        <p className={`text-xs font-medium ${
          showRuledOut ? 'text-accent-red' :
          team.injured.length >= 3 ? 'text-accent-amber' :
          'text-ink-muted'
        }`}>
          {team.headline}
        </p>

        {showRuledOut && (
          <Section title="Ruled out (by news)" tone="red">
            {team.ruledOutByNews.map(l => <PlayerLine key={l.playerId} line={l} />)}
          </Section>
        )}

        {team.injured.length > 0 && (
          <Section title="Flagged / doubtful" tone="amber">
            {team.injured
              .filter(l => !team.ruledOutByNews.some(r => r.playerId === l.playerId))
              .map(l => <PlayerLine key={l.playerId} line={l} />)}
          </Section>
        )}

        {team.nailedStarters.length > 0 && (
          <Section title="Nailed starters" tone="green">
            {team.nailedStarters.slice(0, 11).map(l => <PlayerLine key={l.playerId} line={l} />)}
          </Section>
        )}

        {team.rotationRisk.length > 0 && (
          <Section title="Rotation risk" tone="steel">
            {team.rotationRisk.slice(0, 6).map(l => <PlayerLine key={l.playerId} line={l} />)}
          </Section>
        )}
      </div>
    </Card>
  );
}

function Section({ title, tone, children }: {
  title: string; tone: 'green' | 'amber' | 'red' | 'steel'; children: React.ReactNode
}) {
  const dot = {
    green: 'bg-accent-green',
    amber: 'bg-accent-amber',
    red:   'bg-accent-red',
    steel: 'bg-ink-dim',
  }[tone];
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden />
        <h3 className="text-[10px] uppercase tracking-widest text-ink-dim font-semibold">{title}</h3>
      </div>
      <ul className="space-y-1">{children}</ul>
    </div>
  );
}

function PlayerLine({ line }: { line: PressPlayerLine }) {
  const cost = (line.cost / 10).toFixed(1);
  const mins = line.expectedMinutes != null ? Math.round(line.expectedMinutes) : null;
  const startPct = line.startProb != null ? Math.round(line.startProb * 100) : null;
  return (
    <li className="text-xs">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-medium">{line.webName}</span>
        <span className="text-ink-dim">{line.position} · £{cost}m</span>
        {mins !== null && startPct !== null && (
          <span className="font-mono text-ink-muted">{startPct}% · {mins}'</span>
        )}
        {line.startSignalCount > 0 && (
          <span className="font-mono text-accent-green">+{line.startSignalCount}</span>
        )}
        {line.benchSignalCount > 0 && (
          <span className="font-mono text-accent-amber">-{line.benchSignalCount}</span>
        )}
        {line.injurySignalCount > 0 && (
          <span className="font-mono text-accent-red">{line.injurySignalCount}⚕</span>
        )}
      </div>
      {line.news && (
        <p className="text-[11px] text-ink-muted italic mt-0.5">
          FPL: {line.news.length > 100 ? line.news.slice(0, 100) + '…' : line.news}
        </p>
      )}
      {line.topQuote && (
        <p className="text-[11px] text-ink-muted mt-0.5">
          <span className="text-ink-dim">{line.topQuoteChannel}: </span>
          “{line.topQuote.length > 140 ? line.topQuote.slice(0, 140) + '…' : line.topQuote}”
          {line.topQuoteUrl && (
            <>
              {' '}
              <a href={line.topQuoteUrl} target="_blank" rel="noopener noreferrer"
                 className="text-accent-blue hover:underline">video↗</a>
            </>
          )}
        </p>
      )}
      {line.reasons.length > 0 && (
        <p className="text-[10px] text-ink-dim mt-0.5">{line.reasons.join(' · ')}</p>
      )}
    </li>
  );
}
