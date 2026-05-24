import { Badge } from './ui/Badge';
import { fmt, pct } from '@/lib/util/fmt';

export interface RecommendationCardData {
  title: string;
  verdict: 'do_nothing' | 'roll' | 'ft1' | 'ft2' | 'ft3' | 'ft4' | 'ft5' |
            'hit_-4' | 'hit_-8' | 'wildcard' |
            'captain' | 'tc' | 'bb' | 'fh' | 'wc';
  ev: number;
  risk: number;
  confidence: number;
  opportunityCost?: number;
  reasons: string[];
}

export function RecommendationCard({ d }: { d: RecommendationCardData }) {
  const tone =
    d.ev > 1.5 ? 'green' :
    d.ev > 0.5 ? 'amber' :
    'steel';
  return (
    <div className="bg-bg-card border border-line rounded-card p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold">{d.title}</h4>
        <Badge tone={tone as any}>{(d.verdict ?? '').replace('_', ' ')}</Badge>
      </div>
      <div className="grid grid-cols-3 gap-3 font-mono">
        <Stat label="EV"         value={fmt(d.ev, 2)} accent />
        <Stat label="risk"       value={pct(d.risk, 0)} />
        <Stat label="confidence" value={pct(d.confidence, 0)} />
      </div>
      {Array.isArray(d.reasons) && d.reasons.length > 0 && (
        <ul className="text-xs text-ink-muted space-y-1">
          {d.reasons.map((r, i) => <li key={i}>· {r}</li>)}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-bg-inset rounded-md py-2 text-center">
      <div className={accent ? 'text-accent-green text-lg' : 'text-lg'}>{value}</div>
      <div className="text-[10px] text-ink-dim">{label}</div>
    </div>
  );
}
