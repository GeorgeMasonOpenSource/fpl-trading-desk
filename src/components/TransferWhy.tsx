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
          <Section title="Recent 5 played">
            {ins.recent.apps === 0 ? (
              <span className="text-ink-dim">No appearances yet.</span>
            ) : (
              <span className="font-mono">
                {ins.recent.apps} apps · {ins.recent.minutes}′ · {ins.recent.goals}G {ins.recent.assists}A ·
                {' '}xG {fmt(ins.recent.xg, 1)} · xA {fmt(ins.recent.xa, 1)} ·
                {' '}{ins.recent.bonus} bonus · <span className="text-ink">{ins.recent.fplPoints} pts</span>
              </span>
            )}
          </Section>

          <Section title="Season">
            <span className="font-mono">
              {ins.season.starts} starts · {ins.season.minutes}′ ·
              {' '}{ins.season.goals}G {ins.season.assists}A ·
              {' '}xG {fmt(ins.season.xg, 1)} · xA {fmt(ins.season.xa, 1)} ·
              {' '}{ins.season.bonus} bonus
            </span>
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
