import { ProbabilityBar } from './ui/Badge';

export function ModelConfidencePanel({
  minutesConfidence, modelConfidence, reliability
}: { minutesConfidence: number; modelConfidence: number; reliability: number }) {
  return (
    <div className="bg-bg-inset border border-line rounded-card p-3 space-y-2 text-sm">
      <Row label="Minutes confidence"   value={minutesConfidence} tone="blue" />
      <Row label="Model confidence"     value={modelConfidence}   tone="green" />
      <Row label="Historical reliability" value={reliability}     tone="amber" />
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: number; tone: any }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-ink-muted text-xs">{label}</span>
      <ProbabilityBar value={value} tone={tone} />
    </div>
  );
}
