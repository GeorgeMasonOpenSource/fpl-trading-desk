import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { RecommendationCard } from '@/components/RecommendationCard';
import { StaleDataWarning } from '@/components/StaleDataWarning';
import { PlayerCard, PlayerCardData } from '@/components/PlayerCard';
import { SetupCard } from '@/components/SetupCard';
import { currentGameweek, lastIngestAt, managerSummary, squadForGameweek } from '@/lib/db/queries';
import { compareTransferScenarios } from '@/lib/transfers/optimiser';
import { rankCaptains } from '@/lib/captaincy/engine';
import { getManagerId, getLeagueId } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Server actions originating from this page (connectManager etc.) inherit this
// timeout. Vercel Hobby caps at 60s; we set the max so the first connect has
// breathing room even on cold starts.
export const maxDuration = 60;

export default async function DashboardPage() {
  const managerId = getManagerId();
  const leagueId  = getLeagueId();
  const evThreshold = Number(process.env.EV_TRANSFER_THRESHOLD ?? 0.6);
  const hitThreshold = Number(process.env.EV_HIT_THRESHOLD ?? 1.5);

  const gw = await currentGameweek();
  const ingest = await lastIngestAt();

  // Not connected — surface the setup card.
  if (!managerId) {
    return (
      <div className="space-y-6">
        <header>
          <div className="text-xs uppercase tracking-widest text-ink-dim">Dashboard</div>
          <h1 className="text-2xl font-semibold">Welcome to the Trading Desk</h1>
          <p className="text-sm text-ink-muted mt-1">
            Connect your FPL team to price your next move.
          </p>
        </header>
        <SetupCard prefillManager={null} prefillLeague={null} />
        <Card title="What you'll get the moment you connect">
          <ul className="text-sm text-ink-muted space-y-1.5 list-disc list-inside marker:text-ink-dim">
            <li>Your full squad with expected minutes distribution and xPts breakdown.</li>
            <li>Transfer routes (do-nothing, roll, ft1, ft2, -4, -8, wildcard) priced over 1/3/6/8 GW horizons.</li>
            <li>Captaincy ranking with safe / aggressive / mini-league / triple-captain buckets.</li>
            <li>Chip value timeline for WC / FH / BB / TC.</li>
            <li>Mini-league war room: threats, helpers, captain differences, point-swing events.</li>
            <li>Manual factual overrides whenever you have news the model doesn't.</li>
          </ul>
        </Card>
      </div>
    );
  }

  // Connected but no current GW yet — DB is empty / migrations only.
  if (!gw) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <StaleDataWarning lastIngest={ingest} />
        <Card title="No gameweek data yet">
          <p className="text-sm text-ink-muted">
            Hit <span className="font-mono">Refresh now</span> in the bar above
            to fetch FPL data. If your database is empty, run the migrations
            first (see README).
          </p>
        </Card>
      </div>
    );
  }

  const summary = await managerSummary(managerId);
  const squad   = await squadForGameweek(managerId, gw.id);

  // If the user just connected but recompute didn't run for any reason, the
  // squad may exist but projections won't. Avoid running the optimiser on
  // empty data — it's a footgun.
  const hasProjections = squad.some(p => Number(p.xpts_total) > 0);
  const scenarios = hasProjections
    ? await compareTransferScenarios({
        managerId, startGameweek: gw.id,
        freeTransfers: summary?.free_transfers ?? 1,
        evThreshold, hitThreshold
      })
    : [];
  const captains = hasProjections
    ? await rankCaptains(managerId, gw.id, leagueId ?? undefined)
    : null;

  const recommendedScenario = scenarios.slice().sort((a, b) => b.ev - a.ev)[0] ?? null;
  const rollScenario = scenarios.find(s => s.scenario === 'roll');
  const recommend = (recommendedScenario && recommendedScenario.ev >= evThreshold)
    ? recommendedScenario
    : rollScenario;

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <div className="text-xs uppercase tracking-widest text-ink-dim">Dashboard</div>
          <h1 className="text-2xl font-semibold">{gw.name} · deadline {new Date(gw.deadline).toUTCString()}</h1>
        </div>
        <div className="flex gap-2">
          <Badge tone="blue">Manager {managerId}</Badge>
          {summary && <Badge tone="steel">FT {summary.free_transfers}</Badge>}
          {summary && <Badge tone="steel">£{(summary.bank/10).toFixed(1)}m bank</Badge>}
        </div>
      </header>

      <StaleDataWarning lastIngest={ingest} />

      {!hasProjections && (
        <Card title="Models haven't been computed yet">
          <p className="text-sm text-ink-muted">
            Your squad is loaded but the projection / minutes models haven't
            run for this gameweek. Click <span className="font-mono">Refresh now</span> in
            the top bar.
          </p>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {recommend && (
          <RecommendationCard d={{
            title: 'Recommended action',
            verdict: recommend.scenario,
            ev: recommend.ev,
            risk: recommend.risk,
            confidence: recommend.confidence,
            reasons: recommend.reasons
          }} />
        )}
        {captains?.safe && (
          <RecommendationCard d={{
            title: `Safe captain · ${captains.safe.webName}`,
            verdict: 'captain',
            ev: captains.safe.projection,
            risk: 1 - captains.safe.startProb,
            confidence: 0.8,
            reasons: captains.safe.reasons
          }} />
        )}
        {captains?.aggressive && (
          <RecommendationCard d={{
            title: `Aggressive captain · ${captains.aggressive.webName}`,
            verdict: 'captain',
            ev: captains.aggressive.ceiling,
            risk: 0.4,
            confidence: 0.6,
            reasons: ['Highest ceiling among your top 6 projections.']
          }} />
        )}
      </div>

      <Card title="My team — minutes & xPts">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {squad.map(p => {
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
