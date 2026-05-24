import type { PlayerInsight } from '@/lib/transfers/insights';
import { fmt } from '@/lib/util/fmt';

/**
 * Renders the underlying data behind a transfer suggestion. Shows the IN
 * player's recent form + upcoming fixtures + role flags, and the same for
 * the OUT player so the gap is obvious. Pure presentational — caller passes
 * the insights it already fetched.
 */
export function TransferWhy({
  outName, inName,
  outInsight, inInsight
}: {
  outName: string;
  inName: string;
  outInsight?: PlayerInsight;
  inInsight?: PlayerInsight;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
      <PlayerPanel label="Outgoing" name={outName} ins={outInsight} tone="red" />
      <PlayerPanel label="Incoming" name={inName} ins={inInsight} tone="green" />
    </div>
  );
}

function PlayerPanel({ label, name, ins, tone }: {
  label: string;
  name: string;
  ins?: PlayerInsight;
  tone: 'green' | 'red';
}) {
  const border = tone === 'green' ? 'border-accent-green/30' : 'border-accent-red/30';
  return (
    <div className={`bg-bg-inset border ${border} rounded-md p-3 space-y-2`}>
      <div className="flex items-baseline justify-between">
        <div className="font-medium">{name}</div>
        <div className="text-[10px] uppercase tracking-widest text-ink-dim">{label}</div>
      </div>

      {!ins ? (
        <div className="text-ink-dim italic">No data yet.</div>
      ) : (
        <>
          <Section title="Last 5 played — match by match">
            {ins.matches.length === 0 ? (
              <span className="text-ink-dim">No appearances on file yet. Run db:seed to backfill history.</span>
            ) : (
              <table className="w-full text-[11px] font-mono">
                <thead className="text-ink-dim">
                  <tr>
                    <th className="text-left">GW</th>
                    <th className="text-left">vs</th>
                    <th className="text-right">min</th>
                    <th className="text-right">G</th>
                    <th className="text-right">A</th>
                    <th className="text-right">xG</th>
                    <th className="text-right">xA</th>
                    <th className="text-right">B</th>
                    <th className="text-right">pts</th>
                  </tr>
                </thead>
                <tbody>
                  {ins.matches.map(m => (
                    <tr key={m.gw} className={m.minutes === 0 ? 'text-ink-dim' : ''}>
                      <td className="text-left">{m.gw}</td>
                      <td className="text-left">
                        {m.opp}{m.home ? '(H)' : '(A)'}
                        {!m.started && m.minutes > 0 && <span className="text-ink-dim ml-1">·sub</span>}
                        {m.minutes === 0 && <span className="text-ink-dim ml-1">·DNP</span>}
                      </td>
                      <td className="text-right">{m.minutes}</td>
                      <td className="text-right">{m.goals || ''}</td>
                      <td className="text-right">{m.assists || ''}</td>
                      <td className="text-right">{fmt(m.xg, 1)}</td>
                      <td className="text-right">{fmt(m.xa, 1)}</td>
                      <td className="text-right">{m.bonus || ''}</td>
                      <td className={`text-right ${m.fplPoints >= 6 ? 'text-accent-green' : m.fplPoints >= 3 ? 'text-ink' : 'text-ink-dim'}`}>
                        {m.fplPoints}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-line text-ink-dim">
                    <td className="text-left">tot</td>
                    <td></td>
                    <td className="text-right">{ins.recent.minutes}</td>
                    <td className="text-right">{ins.recent.goals}</td>
                    <td className="text-right">{ins.recent.assists}</td>
                    <td className="text-right">{fmt(ins.recent.xg, 1)}</td>
                    <td className="text-right">{fmt(ins.recent.xa, 1)}</td>
                    <td className="text-right">{ins.recent.bonus}</td>
                    <td className="text-right text-ink">{ins.recent.fplPoints}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </Section>

          <Section title="Season">
            <span className="font-mono">
              {ins.season.starts} starts · {ins.season.minutes}′ ·
              {' '}{ins.season.goals}G {ins.season.assists}A ·
              {' '}xG {fmt(ins.season.xg, 1)} · xA {fmt(ins.season.xa, 1)} ·
              {' '}{ins.season.bonus} bonus
              {ins.season.defconPer90 > 0 && (
                <> · {fmt(ins.season.defconPer90, 1)} defcon/90</>
              )}
            </span>
            {/* §per-90 — scan-friendly rates so the user can compare OUT
                vs IN on the same basis. All four are derived from season
                totals divided by minutes; safe to show when minutes > 0. */}
            {ins.season.minutes > 0 && (
              <span className="block text-[10px] text-ink-dim mt-0.5 font-mono">
                xG/90 {fmt(ins.season.xgPer90, 2)} · xA/90 {fmt(ins.season.xaPer90, 2)}
                {' · '}bonus/90 {fmt(ins.season.bonusPer90, 2)}
                {ins.season.defconPer90 > 0 && <> · defcon/90 {fmt(ins.season.defconPer90, 1)}</>}
              </span>
            )}
            {/* Open-play xG split. If the player is a pen taker, the
                headline xG above includes their penalty xG. We strip an
                estimate of pen xG (penalty_share × 5 pens/season × 0.78)
                so the open-play number reflects underlying goal threat
                from open play only. */}
            {ins.roles.penaltyOrder && ins.roles.penaltyOrder <= 2 && (
              <span className="block text-[10px] text-ink-dim mt-0.5 font-mono">
                pen-adj open-play xG ≈ {fmt(
                  Math.max(0, ins.season.xg - estimatePenXg(ins.roles.penaltyOrder)),
                  1
                )}
                {' '}(stripped ≈ {fmt(estimatePenXg(ins.roles.penaltyOrder), 1)} pen xG)
              </span>
            )}
          </Section>

          {/* Shot profile — Understat per-situation xG. The single best
              "shot picture" we have: open-play shot volume, shot quality
              (xG/shot), and the finishing delta (npGoals - npxG). For a
              forward this is the most important diagnostic. */}
          {ins.shots && (ins.shots.openPlayShots + ins.shots.setPieceShots + ins.shots.directFkShots) > 0 && (
            <Section title="Shot profile (Understat)">
              <table className="w-full text-[11px] font-mono">
                <thead className="text-ink-dim">
                  <tr>
                    <th className="text-left"></th>
                    <th className="text-right">shots</th>
                    <th className="text-right">xG</th>
                    <th className="text-right">goals</th>
                    <th className="text-right">xG/shot</th>
                  </tr>
                </thead>
                <tbody>
                  {ins.shots.openPlayShots > 0 && (
                    <tr>
                      <td className="text-left text-ink-dim">open play</td>
                      <td className="text-right">{ins.shots.openPlayShots}</td>
                      <td className="text-right">{fmt(ins.shots.openPlayXg, 2)}</td>
                      <td className="text-right">{ins.shots.goalsOpenPlay}</td>
                      <td className={`text-right ${ins.shots.xgPerOpenPlayShot >= 0.14 ? 'text-accent-green' : ins.shots.xgPerOpenPlayShot >= 0.08 ? 'text-ink' : 'text-ink-dim'}`}>
                        {fmt(ins.shots.xgPerOpenPlayShot, 3)}
                      </td>
                    </tr>
                  )}
                  {ins.shots.setPieceShots > 0 && (
                    <tr>
                      <td className="text-left text-ink-dim">set piece</td>
                      <td className="text-right">{ins.shots.setPieceShots}</td>
                      <td className="text-right">{fmt(ins.shots.setPieceXg, 2)}</td>
                      <td className="text-right">{ins.shots.goalsSetPiece}</td>
                      <td className="text-right text-ink-dim">—</td>
                    </tr>
                  )}
                  {ins.shots.directFkShots > 0 && (
                    <tr>
                      <td className="text-left text-ink-dim">direct FK</td>
                      <td className="text-right">{ins.shots.directFkShots}</td>
                      <td className="text-right">{fmt(ins.shots.directFkXg, 2)}</td>
                      <td className="text-right">{ins.shots.goalsDirectFk}</td>
                      <td className="text-right text-ink-dim">—</td>
                    </tr>
                  )}
                  {ins.shots.penaltyShots > 0 && (
                    <tr>
                      <td className="text-left text-ink-dim">penalty</td>
                      <td className="text-right">{ins.shots.penaltyShots}</td>
                      <td className="text-right">{fmt(ins.shots.penaltyXg, 2)}</td>
                      <td className="text-right">{ins.shots.goalsPenalty}</td>
                      <td className="text-right text-ink-dim">—</td>
                    </tr>
                  )}
                  <tr className="border-t border-line">
                    <td className="text-left text-ink-dim">npxG</td>
                    <td colSpan={2} className="text-right">{fmt(ins.shots.npxg, 2)}</td>
                    <td className="text-right">{ins.shots.npGoals} np-goals</td>
                    <td className={`text-right ${ins.shots.npFinishingDelta >= 0 ? 'text-accent-green' : 'text-accent-amber'}`}>
                      {ins.shots.npFinishingDelta >= 0 ? '+' : ''}{fmt(ins.shots.npFinishingDelta, 1)}
                    </td>
                  </tr>
                </tbody>
              </table>
              {/* §per-90 — shot rates per 90 minutes so the user can
                  compare candidates on the same basis. Big-chances is a
                  proxy: shots-volume weighted by how far xG/shot is above
                  0.15, so only above-average chances contribute. */}
              <div className="text-[10px] font-mono text-ink-muted mt-1">
                open-play shots/90 {fmt(ins.shots.openPlayShotsPer90, 2)}
                {' · '}open-play xG/90 {fmt(ins.shots.openPlayXgPer90, 2)}
                {ins.shots.bigChancesPer90 > 0 && (
                  <> · big-chance proxy/90 {fmt(ins.shots.bigChancesPer90, 2)}</>
                )}
              </div>
              <div className="text-[10px] text-ink-dim mt-1">
                npxG = non-penalty expected goals · finishing Δ = np-goals − npxG.{' '}
                {ins.shots.npFinishingDelta >= 2
                  ? 'Over-finishing — regression risk down.'
                  : ins.shots.npFinishingDelta <= -2
                  ? 'Under-finishing — regression upside.'
                  : 'In line with expected.'}
              </div>
            </Section>
          )}

          {/* Bayesian player priors. Tells the user this isn't just hot
              form — the model has fitted a season-long multiplier from
              actuals vs expected. */}
          {ins.priors && (ins.priors.goalMult !== 1 || ins.priors.bonusMult !== 1 || ins.priors.assistMult !== 1) && (
            <Section title="Player priors (Bayesian)">
              <span className="font-mono">
                goals {fmt(ins.priors.goalMult, 2)}× · assists {fmt(ins.priors.assistMult, 2)}× · bonus {fmt(ins.priors.bonusMult, 2)}×
              </span>
              <div className="text-[10px] text-ink-dim mt-0.5">
                Shrunk over {fmt(ins.priors.sample90s, 0)} 90s · confidence {fmt(ins.priors.confidence * 100, 0)}%.
                {ins.priors.goalMult >= 1.15 && ' Model treats him as an elite finisher.'}
                {ins.priors.goalMult <= 0.85 && ' Model is fading the finishing — wasteful in the box.'}
                {ins.priors.bonusMult >= 1.15 && ' Bonus magnet — over-performs BPS-from-xG.'}
              </div>
            </Section>
          )}

          {/* Opponent defence vs this player's position — the position-
              specific FDR, more useful than the generic 1-5 number. */}
          {ins.oppDefence && (
            <Section title={`Next opp defence vs ${ins.position}`}>
              <span className="font-mono">
                {ins.oppDefence.oppShort} concede {fmt(ins.oppDefence.xgConcededPerMatch, 2)} xG/match to {ins.position}s ·
                {' '}{fmt(ins.oppDefence.defenceMultiplier, 2)}× league avg
              </span>
              <div className={`text-[10px] mt-0.5 ${ins.oppDefence.defenceMultiplier >= 1.15 ? 'text-accent-green' : ins.oppDefence.defenceMultiplier <= 0.85 ? 'text-accent-red' : 'text-ink-dim'}`}>
                {ins.oppDefence.defenceMultiplier >= 1.15
                  ? `${((ins.oppDefence.defenceMultiplier - 1) * 100).toFixed(0)}% leakier than average — favourable matchup.`
                  : ins.oppDefence.defenceMultiplier <= 0.85
                  ? `${((1 - ins.oppDefence.defenceMultiplier) * 100).toFixed(0)}% tighter than average — tough matchup.`
                  : `Roughly league-average defence vs ${ins.position}s.`}
                {' '}({ins.oppDefence.matches} matches sampled.)
              </div>
            </Section>
          )}

          <Section title="Next 3 fixtures">
            {ins.upcoming.length === 0 ? (
              <span className="text-ink-dim">Season over.</span>
            ) : (
              <span className="font-mono space-x-1.5">
                {ins.upcoming.map((f, i) => (
                  <span key={i} className={fdrTone(f.fdr)}>
                    GW{f.gw}: {f.opp}{f.home ? '(H)' : '(A)'} <span className="text-ink-dim">fdr {f.fdr}</span>
                  </span>
                ))}
              </span>
            )}
          </Section>

          {(ins.roles.penaltyOrder || ins.roles.cornersOrder || ins.roles.freekicksOrder) && (
            <Section title="Role">
              <span className="space-x-2">
                {ins.roles.penaltyOrder && (
                  <span className="font-mono">pen #{ins.roles.penaltyOrder}</span>
                )}
                {ins.roles.cornersOrder && (
                  <span className="font-mono">corners #{ins.roles.cornersOrder}</span>
                )}
                {ins.roles.freekicksOrder && (
                  <span className="font-mono">FK #{ins.roles.freekicksOrder}</span>
                )}
              </span>
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="leading-relaxed">
      <div className="text-[10px] uppercase tracking-widest text-ink-dim">{title}</div>
      <div>{children}</div>
    </div>
  );
}

function fdrTone(fdr: number) {
  if (fdr <= 2) return 'text-accent-green';
  if (fdr === 3) return 'text-ink';
  if (fdr === 4) return 'text-accent-amber';
  return 'text-accent-red';
}

/**
 * Rough estimate of how much of a player's season xG came from penalties,
 * based on their FPL penalties_order. Used to surface "open-play xG" so the
 * user can see the underlying goal threat without the penalty inflation that
 * the headline xG number carries for pen takers.
 *
 *   #1 taker  → ~0.95 share of team's ~5 pens × 0.78 conversion ≈ 3.7 xG
 *   #2 taker  → ~0.30 share ≈ 1.17 xG
 *   #3+ or none → ~0
 *
 * Conservative — real team pen-rate varies (Liverpool earn more pens than
 * Burnley) but 5/season is a reasonable league mean.
 */
function estimatePenXg(penOrder: number | null): number {
  if (!penOrder) return 0;
  if (penOrder === 1) return 5 * 0.95 * 0.78;
  if (penOrder === 2) return 5 * 0.30 * 0.78;
  return 0;
}
