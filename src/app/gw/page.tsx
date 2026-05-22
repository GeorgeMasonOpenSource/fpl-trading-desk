/**
 * GW Decision page — clean homepage.
 *
 * Mobile-first, decision-first. One screen, three core cards
 * (transfer / captain / chip) plus contextual alerts. Everything else
 * accessible via the bottom nav grid.
 *
 * Visual system: DecisionCard primitive does all the heavy lifting.
 * Generous whitespace, single visual primitive, no nested borders.
 */
import { getGameweeks, managerSummary, newsWatch } from '@/lib/db/queries';
import { compareTransferScenarios, rankTopTransfers } from '@/lib/transfers/optimiser';
import { rankCaptains } from '@/lib/captaincy/engine';
import { getManagerId, getLeagueId, getUsedChips } from '@/lib/session';
import { NotConnected } from '@/components/NotConnected';
import { DecisionCard, AccentNumber, NavGrid } from '@/components/DecisionCard';
import { loadCalibrationContext, calibrateOne } from '@/lib/projections/calibration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 60;

export default async function GwPage() {
  const managerId = getManagerId();
  if (!managerId) return <NotConnected where="This Gameweek" />;
  const leagueId = getLeagueId() ?? undefined;
  const { planning } = await getGameweeks();
  if (!planning) {
    return (
      <div className="max-w-md mx-auto p-4">
        <p className="text-ink-muted text-sm">No upcoming gameweek yet.</p>
      </div>
    );
  }

  const safe = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch { return fallback; }
  };

  const [summary, scenarios, topTransfers, captains, news, calCtx] = await Promise.all([
    safe(() => managerSummary(managerId), null),
    safe(() => compareTransferScenarios({
      managerId, startGameweek: planning.id,
      freeTransfers: 1, evThreshold: 0.6, hitThreshold: 1.5
    }), [] as any),
    safe(() => rankTopTransfers(managerId, planning.id, 3), []),
    safe(() => rankCaptains(managerId, planning.id, leagueId), null),
    safe(() => newsWatch(managerId, planning.id), [] as any),
    safe(() => loadCalibrationContext(planning.id), {
      calibrationByPosition: new Map(),
      benchmarksByPlayer: new Map(),
      consensusByPlayer: new Map()
    })
  ]);

  // Filter chip scenarios by used chips.
  const usedChips = getUsedChips();
  const blockedByChip: Record<string, string> = {
    wildcard: 'WC', free_hit: 'FH', bench_boost: 'BB', triple_captain: 'TC'
  };
  const availableScenarios = scenarios.filter((s: any) => {
    const chip = blockedByChip[s.scenario];
    return !chip || !usedChips.has(chip as any);
  });

  const headline = topTransfers[0] ?? null;
  const calibrateXpts = (playerId: number, position: string, rawXpts: number) =>
    calibrateOne({
      rawXpts, playerId,
      position: position as 'GKP'|'DEF'|'MID'|'FWD',
      calibrationByPosition: calCtx.calibrationByPosition,
      benchmarkForPlayer: calCtx.benchmarksByPlayer.get(playerId),
      consensusForPlayer: calCtx.consensusByPlayer.get(playerId)
    });
  const headlineInCal = headline ? calibrateXpts(headline.in.playerId, headline.in.position, headline.in.xpts1) : null;

  const captainPick = captains?.recommended ?? captains?.aggressive ?? null;
  const safeCap = captains?.safe ?? null;

  // Chip recommendation only if it clears the threshold.
  const chipRec = availableScenarios
    .filter((s: any) => Object.values(blockedByChip).includes(blockedByChip[s.scenario]))
    .sort((a: any, b: any) => b.ev - a.ev)[0];
  const showChipCard = chipRec && chipRec.ev >= 1.0;

  // Urgent news = high-severity items only.
  const urgentNews = (news as any[]).filter((n: any) => n.severity === 'high' || (n.chance_of_playing_next_round != null && n.chance_of_playing_next_round <= 50));

  return (
    <div className="max-w-lg mx-auto px-3 py-4 space-y-3">
      {/* Header — minimal, breathing room */}
      <header className="px-1">
        <div className="text-[10px] uppercase tracking-[0.2em] text-ink-dim">
          {planning.name} · Decision
        </div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight leading-none">
          Your move
        </h1>
        {summary?.free_transfers != null && (
          <div className="mt-2 text-[11px] font-mono text-ink-dim flex gap-2 items-center">
            <span className="text-ink-muted">{summary.free_transfers} FT</span>
            <span>·</span>
            <span className="text-ink-muted">£{(Number(summary.bank ?? 0) / 10).toFixed(1)}m</span>
            {urgentNews.length > 0 && (
              <>
                <span>·</span>
                <a href="/my-team" className="text-accent-amber">⚠ {urgentNews.length}</a>
              </>
            )}
          </div>
        )}
      </header>

      {/* HEADLINE: Recommended transfer */}
      {headline && headlineInCal ? (
        <DecisionCard
          eyebrow="Transfer"
          main={
            <span>
              <span className="text-ink-muted line-through font-normal text-base">{headline.out.webName}</span>
              <span className="text-ink-dim mx-2">→</span>
              {headline.in.webName}
            </span>
          }
          meta={`${headline.in.position} · ${headline.in.teamShort} · £${(headline.in.cost / 10).toFixed(1)}m`}
          accent={
            <AccentNumber
              value={`+${headline.evGain1.toFixed(1)}`}
              unit="EV"
              tone={headline.evGain1 > 1.5 ? 'positive' : 'neutral'}
            />
          }
          tone={headline.evGain1 > 1.5 ? 'positive' : 'neutral'}
          details={
            <>
              <div>
                <span className="text-accent-green">+</span>{' '}
                <span className="text-ink">{headline.in.webName}</span> projects{' '}
                <span className="font-mono tabular-nums">{headlineInCal.calibrated.toFixed(1)}</span> xPts
                {headlineInCal.consensusAdjustment !== 0 && (
                  <span className="ml-1 text-ink-dim">(incl. {headlineInCal.consensusAdjustment > 0 ? '+' : ''}{headlineInCal.consensusAdjustment.toFixed(2)} creator)</span>
                )}
              </div>
              <div>
                <span className="text-accent-red">−</span>{' '}
                <span className="text-ink">{headline.out.webName}</span> projects{' '}
                <span className="font-mono tabular-nums">{headline.out.xpts1.toFixed(1)}</span> xPts
              </div>
              <div className="text-ink-dim text-[11px]">
                Net £{headline.netCost === 0 ? '0' : `${headline.netCost > 0 ? '-' : '+'}${(Math.abs(headline.netCost) / 10).toFixed(1)}m`}
                {' · '}
                3 GW {headline.evGain3 >= 0 ? '+' : ''}{headline.evGain3.toFixed(1)} EV
                {headline.changesCaptain ? ' · new captain' : ''}
              </div>
              {(() => {
                const cs = calCtx.consensusByPlayer.get(headline.in.playerId);
                if (!cs || cs.distinctCreators === 0) return null;
                return (
                  <div className="text-accent-violet">
                    📺 {cs.reason}
                  </div>
                );
              })()}
              <a href="/transfer-planner" className="inline-block mt-2 text-accent-green text-[11px] hover:underline">
                see top 10 →
              </a>
            </>
          }
        />
      ) : (
        <DecisionCard
          eyebrow="Transfer"
          main="Roll your FT"
          meta="No move clears the EV threshold this week"
          tone="neutral"
        />
      )}

      {/* CAPTAIN */}
      {captainPick && (
        <DecisionCard
          eyebrow="Captain"
          main={captainPick.webName}
          meta={`${captainPick.position} · ${captainPick.teamShort}`}
          accent={
            <AccentNumber
              value={captainPick.projection.toFixed(1)}
              unit="xPts ×2"
              tone="positive"
            />
          }
          tone="positive"
          details={
            <>
              <div>
                Floor <span className="font-mono tabular-nums">{captainPick.floor.toFixed(1)}</span>
                {' · '}
                Ceiling <span className="font-mono tabular-nums">{captainPick.ceiling.toFixed(1)}</span>
                {' · '}
                Start <span className="font-mono tabular-nums">{(captainPick.startProb * 100).toFixed(0)}%</span>
              </div>
              {safeCap && safeCap.playerId !== captainPick.playerId && (
                <div>
                  Safer pick: <span className="text-ink">{safeCap.webName}</span>{' '}
                  <span className="font-mono tabular-nums text-ink-muted">{safeCap.projection.toFixed(1)}</span>
                </div>
              )}
              <a href="/captaincy" className="inline-block mt-1 text-accent-green text-[11px] hover:underline">
                full ranking →
              </a>
            </>
          }
        />
      )}

      {/* CHIP — only if a chip clears the threshold */}
      {showChipCard && (
        <DecisionCard
          eyebrow="Chip"
          main={chipRec.scenario.replace('_', ' ')}
          meta={`Projected EV +${chipRec.ev.toFixed(1)} · ${(chipRec.risk * 100).toFixed(0)}% risk`}
          accent={
            <AccentNumber value={`+${chipRec.ev.toFixed(1)}`} unit="EV" tone="warning" />
          }
          tone="warning"
          href="/chip-planner"
        />
      )}

      {/* URGENT NEWS — only if any */}
      {urgentNews.length > 0 && (
        <DecisionCard
          eyebrow={`⚠ ${urgentNews.length} alert${urgentNews.length === 1 ? '' : 's'}`}
          main={urgentNews.slice(0, 2).map(n => n.web_name ?? n.webName).join(', ') + (urgentNews.length > 2 ? '…' : '')}
          meta="Tap to triage on My Team"
          href="/my-team"
          tone="warning"
        />
      )}

      {/* Bottom nav */}
      <NavGrid
        items={[
          { href: '/transfer-planner',  label: 'Transfers',      sublabel: 'top 10' },
          { href: '/captaincy',         label: 'Captaincy',      sublabel: 'risk-adjusted' },
          { href: '/predicted-lineups', label: 'Lineups',        sublabel: 'predicted XI' },
          { href: '/model-audit',       label: 'Why?',           sublabel: 'per-player' },
          { href: '/my-team',           label: 'My team',        sublabel: 'minutes view' },
          { href: '/mini-league',       label: 'Mini league',    sublabel: 'differentials' }
        ]}
      />

      {/* Footer — trained-on-season badge */}
      <footer className="pt-6 text-center text-[10px] text-ink-dim uppercase tracking-widest">
        Trained on 37 GWs · {planning.name}
      </footer>
    </div>
  );
}
