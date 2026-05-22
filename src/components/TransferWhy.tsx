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
            </span>
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
