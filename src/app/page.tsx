import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { RecommendationCard } from '@/components/RecommendationCard';
import { StaleDataWarning } from '@/components/StaleDataWarning';
import { PlayerCard, PlayerCardData } from '@/components/PlayerCard';
import { SetupCard } from '@/components/SetupCard';
import { getGameweeks, lastIngestAt, managerSummary, squadForGameweek, livePoints, newsWatch } from '@/lib/db/queries';
import { NewsWatch } from '@/components/NewsWatch';
import { compareTransferScenarios } from '@/lib/transfers/optimiser';
import { rankCaptains } from '@/lib/captaincy/engine';
import { getManagerId, getLeagueId } from '@/lib/session';
import { n, fmt } from '@/lib/util/fmt';
import { sql } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
// Page-level ISR: even when called dynamically, the cached helpers below
// short-circuit most queries. This is the upper bound on how stale the page
// can be without revalidation.
export const revalidate = 60;

export default async function DashboardPage() {
  const managerId = getManagerId();
  const leagueId  = getLeagueId();
  const evThreshold = Number(process.env.EV_TRANSFER_THRESHOLD ?? 0.6);
  const hitThreshold = Number(process.env.EV_HIT_THRESHOLD ?? 1.5);

  const { current: liveGw, next: planGw, planning } = await getGameweeks();
  const ingest = await lastIngestAt();

  if (!managerId) {
    return (
      <div className="space-y-6">
        <header>
          <div className="text-xs uppercase tracking-widest text-ink-dim">Dashboard</div>
          <h1 className="text-2xl font-semibold">Welcome to the Trading Desk</h1>
          <p className="text-sm text-ink-muted mt-1">Connect your FPL team to price your next move.</p>
        </header>
        <SetupCard prefillManager={null} />
      </div>
    );
  }

  if (!planning) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <StaleDataWarning lastIngest={ingest} />
        <Card title="No gameweek data yet">
          <p className="text-sm text-ink-muted">
            Hit <span className="font-mono">Refresh now</span> in the bar above
            to fetch FPL data. If your database is empty, run <span className="font-mono">npm run db:seed</span> locally first.
          </p>
        </Card>
      </div>
    );
  }

  // All these reads are defensive — if the DB is in a partially-seeded state
  // for the hard-coded manager (e.g. picks loaded but projections not yet),
  // any individual await might throw. Wrap each in a try/catch returning a
  // null/empty sentinel so the page still renders with the bits that DO work.
  const safe = async <T,>(fn: () => Promise<T>, fallback: T, label: string): Promise<T> => {
    try { return await fn(); }
    catch (err) {
      const e = err as Error & { code?: string; detail?: string };
      const msg = e?.message ?? String(err);
      const stack = (e?.stack ?? '').split('\n').slice(0, 8).join(' | ');
      // eslint-disable-next-line no-console
      console.error(`[Dashboard] ${label} FAIL message: ${msg}`);
      console.error(`[Dashboard] ${label} STACK: ${stack}`);
      // Vercel's runtime log table truncates at ~30 chars in the UI. To
      // actually SEE what went wrong, write the error into a debug table
      // we can query from psql / a /debug-errors page. Best-effort — if
      // this insert ALSO fails, swallow it.
      try {
        await sql`
          CREATE TABLE IF NOT EXISTS debug_errors (
            id          BIGSERIAL PRIMARY KEY,
            label       TEXT NOT NULL,
            message     TEXT NOT NULL,
            pg_code     TEXT,
            pg_detail   TEXT,
            stack       TEXT,
            captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `;
        await sql`
          INSERT INTO debug_errors (label, message, pg_code, pg_detail, stack)
          VALUES (${label}, ${msg}, ${e?.code ?? null}, ${e?.detail ?? null}, ${stack})
        `;
      } catch {/* swallow */}
      return fallback;
    }
  };

  // The postgres.js helpers return a RowList<T[]>, not a plain T[]. We cast
  // the fallback empty arrays through `as any` to satisfy the `safe<T>` widen
  // — runtime behaviour is the same (empty iteration) but TypeScript can't
  // infer RowList from a literal `[]`.
  const summary       = await safe(() => managerSummary(managerId), null, 'managerSummary');
  const planningSquad = await safe(
    () => squadForGameweek(managerId, planning.id),
    [] as any as Awaited<ReturnType<typeof squadForGameweek>>,
    'squadForGameweek'
  );
  const news = await safe(
    () => newsWatch(managerId, planning.id),
    [] as any as Awaited<ReturnType<typeof newsWatch>>,
    'newsWatch'
  );
  const live = liveGw
    ? await safe(() => livePoints(managerId, liveGw.id), null, 'livePoints')
    : null;

  const hasProjections = planningSquad.some((p: any) => Number(p.xpts_total) > 0);
  const scenarios = hasProjections
    ? await safe(() => compareTransferScenarios({
        managerId, startGameweek: planning.id,
        freeTransfers: summary?.free_transfers ?? 1,
        evThreshold, hitThreshold
      }), [], 'compareTransferScenarios')
    : [];
  const captains = hasProjections
    ? await safe(() => rankCaptains(managerId, planning.id, leagueId ?? undefined), null, 'rankCaptains')
    : null;

  const recommendedScenario = scenarios.slice().sort((a, b) => b.ev - a.ev)[0] ?? null;
  const rollScenario = scenarios.find(s => s.scenario === 'roll');
  const recommend = (recommendedScenario && recommendedScenario.ev >= evThreshold)
    ? recommendedScenario
    : rollScenario;

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-xs uppercase tracking-widest text-ink-dim">Dashboard</div>
          <h1 className="text-2xl font-semibold">
            {liveGw && !liveGw.finished
              ? <>{liveGw.name} <span className="text-ink-muted text-base font-normal">in progress</span> · planning {planGw?.name ?? planning.name}</>
              : <>Planning {planning.name} · deadline {new Date(planning.deadline).toUTCString().slice(0, 22)}</>
            }
          </h1>
        </div>
        <div className="flex gap-2">
          <Badge tone="blue">Manager {managerId}</Badge>
          {summary && <Badge tone="steel">FT {n(summary.free_transfers, 1)}</Badge>}
          {summary && <Badge tone="steel">£{fmt(n(summary.bank) / 10, 1)}m bank</Badge>}
        </div>
      </header>

      <StaleDataWarning lastIngest={ingest} />

      {live && liveGw && !liveGw.finished && (
        <Card title={`${liveGw.name} live`} subtitle="Updates every ~5 min during match windows"
              action={<Badge tone="green">{live.points} pts so far</Badge>}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm font-mono">
            <div className="bg-bg-inset rounded-md p-3">
              <div className="text-2xl text-accent-green">{live.points}</div>
              <div className="text-[11px] text-ink-dim">Live points</div>
            </div>
            <div className="bg-bg-inset rounded-md p-3">
              <div className="text-2xl">{live.stillToPlay}</div>
              <div className="text-[11px] text-ink-dim">Still to play</div>
            </div>
            <div className="bg-bg-inset rounded-md p-3">
              <div className="text-2xl">{live.rows.filter(r => r.bonus > 0).reduce((s, r) => s + r.bonus, 0)}</div>
              <div className="text-[11px] text-ink-dim">Bonus banked</div>
            </div>
            <div className="bg-bg-inset rounded-md p-3">
              <div className="text-2xl">{live.rows.find(r => r.is_captain)?.web_name ?? '—'}</div>
              <div className="text-[11px] text-ink-dim">Captain</div>
            </div>
          </div>
        </Card>
      )}

      {!hasProjections && (
        <Card title="Models warming up">
          <p className="text-sm text-ink-muted">
            Squad loaded but no projections for {planning.name} yet. The model recompute hasn't run for the planning gameweek. Run{' '}
            <span className="font-mono">npm run db:seed</span> locally with your manager ID, or wait for the daily cron.
          </p>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {recommend && (
          <RecommendationCard d={{
            title: `Recommended action · ${planning.name}`,
            verdict: recommend.scenario,
            ev: recommend.ev, risk: recommend.risk, confidence: recommend.confidence,
            reasons: recommend.reasons
          }} />
        )}
        {captains?.safe && (
          <RecommendationCard d={{
            title: `Safe captain · ${captains.safe.webName}`,
            verdict: 'captain',
            ev: captains.safe.projection,
            risk: 1 - captains.safe.startProb, confidence: 0.8,
            reasons: captains.safe.reasons
          }} />
        )}
        {captains?.aggressive && (
          <RecommendationCard d={{
            title: `Aggressive captain · ${captains.aggressive.webName}`,
            verdict: 'captain',
            ev: captains.aggressive.ceiling, risk: 0.4, confidence: 0.6,
            reasons: ['Highest ceiling among your top 6 projections.']
          }} />
        )}
      </div>

      <NewsWatch items={news as any} />

      <Card title={`My team for ${planning.name} — minutes & xPts`}>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {planningSquad.map(p => {
            const card: PlayerCardData = {
              player_id: p.player_id,
              web_name:  p.web_name,
              position:  p.pos as any,
              team_short: p.team_short,
              xpts_total: Number(p.xpts_total),
              start_prob: Number(p.start_prob),
              sixty_plus_prob: Number(p.sixty_plus_prob),
              ninety_prob: Number(p.ninety_prob),
              sub_prob: Number(p.sub_prob),
              bench_unused_prob: Number(p.bench_unused_prob),
              injury_absence_prob: Number(p.injury_absence_prob),
              expected_minutes: Number(p.expected_minutes),
              rotation_risk: Number(p.rotation_risk),
              rotation_resistance: Number(p.rotation_resistance),
              reliability_index: Number(p.reliability_index),
              minutes_confidence: Number(p.minutes_confidence),
              confidence_score: Number(p.confidence_score),
              floor: Number(p.floor),
              ceiling: Number(p.ceiling),
              risk_score: Number(p.risk_score),
              reasons: p.reasons_json ? JSON.parse(p.reasons_json as string) : null
            };
            return <PlayerCard key={p.player_id} p={card} />;
          })}
        </div>
      </Card>
    </div>
  );
}
