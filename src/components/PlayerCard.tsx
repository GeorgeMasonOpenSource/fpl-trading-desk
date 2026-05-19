import { Badge, ProbabilityBar } from './ui/Badge';
import { teamColour } from '@/lib/util/colours';
import { n, fmt, pct } from '@/lib/util/fmt';

interface Reason { kind: string; weight: number; detail?: string }

export interface PlayerCardData {
  player_id: number;
  web_name: string;
  position: 'GKP' | 'DEF' | 'MID' | 'FWD';
  team_short: string;
  xpts_total: number;
  start_prob: number;
  sixty_plus_prob: number;
  ninety_prob: number;
  sub_prob: number;
  bench_unused_prob: number;
  injury_absence_prob: number;
  expected_minutes: number;
  rotation_risk: number;
  rotation_resistance: number;
  reliability_index: number;
  minutes_confidence: number;
  confidence_score: number;
  floor: number;
  ceiling: number;
  risk_score: number;
  reasons: Reason[] | null;
  last_refresh?: string;
}

export function PlayerCard({ p }: { p: PlayerCardData }) {
  const c = teamColour(p.team_short);
  const rel = n(p.reliability_index);
  const rotR = n(p.rotation_risk);
  const rotRes = n(p.rotation_resistance);
  const relTone = rel > 0.8 ? 'green' : rel > 0.5 ? 'amber' : 'red';
  const rotTone = rotR < 0.15 ? 'green' : rotR < 0.35 ? 'amber' : 'red';
  return (
    <div className="bg-bg-card border border-line rounded-card p-3 flex flex-col gap-3">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="club-block" style={{ ['--c' as any]: c.primary, color: c.secondary }}>
            {p.team_short}
          </span>
          <div>
            <div className="font-semibold leading-tight">{p.web_name}</div>
            <div className="text-[11px] text-ink-dim">{p.position} · {p.team_short}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-lg leading-tight">{fmt(p.xpts_total, 2)}</div>
          <div className="text-[10px] text-ink-dim">xPts</div>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <Row label="Start"     value={n(p.start_prob)} />
        <Row label="60+"       value={n(p.sixty_plus_prob)} />
        <Row label="90"        value={n(p.ninety_prob)}    tone="blue" />
        <Row label="Sub on"    value={n(p.sub_prob)}       tone="amber" />
        <Row label="Bench"     value={n(p.bench_unused_prob)} tone="amber" />
        <Row label="Out"       value={n(p.injury_absence_prob)} tone="red" />
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge tone={relTone as any}>Reliability {pct(rel, 0)}</Badge>
        <Badge tone={rotRes > 0.7 ? 'green' : rotRes > 0.4 ? 'amber' : 'red'}>
          Resistance {pct(rotRes, 0)}
        </Badge>
        <Badge tone={rotTone as any}>Rotation risk {pct(rotR, 0)}</Badge>
        <Badge tone="blue">Min conf {pct(p.minutes_confidence, 0)}</Badge>
        <Badge tone="violet">Model conf {pct(p.confidence_score, 0)}</Badge>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center font-mono">
        <Stat label="floor"   value={fmt(p.floor, 1)} />
        <Stat label="xPts"    value={fmt(p.xpts_total, 1)} accent />
        <Stat label="ceiling" value={fmt(p.ceiling, 1)} />
      </div>

      {Array.isArray(p.reasons) && p.reasons.length > 0 && (
        <details className="text-[11px] text-ink-muted">
          <summary className="cursor-pointer text-ink-dim hover:text-ink">Reason breakdown</summary>
          <ul className="mt-1 space-y-0.5">
            {p.reasons.slice(0, 8).map((r, i) => (
              <li key={i} className="font-mono">
                <span className="text-ink-dim">{r.kind}</span>
                {r.detail && <> · <span>{r.detail}</span></>}
                {' '}<span className="text-ink-dim">({fmt(r.weight, 2)})</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {p.last_refresh && (
        <div className="text-[10px] text-ink-dim font-mono">refreshed {p.last_refresh}</div>
      )}
    </div>
  );
}

function Row({ label, value, tone = 'green' }: {
  label: string; value: number; tone?: 'green' | 'amber' | 'red' | 'blue';
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 text-[11px] text-ink-muted">{label}</span>
      <ProbabilityBar value={value} tone={tone} />
    </div>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-bg-inset rounded-md py-1.5">
      <div className={accent ? 'text-accent-green' : ''}>{value}</div>
      <div className="text-[10px] text-ink-dim">{label}</div>
    </div>
  );
}
