import clsx from 'clsx';
import { ReactNode } from 'react';

const tone = {
  green:  'bg-accent-green/15 text-accent-green',
  amber:  'bg-accent-amber/15 text-accent-amber',
  red:    'bg-accent-red/15   text-accent-red',
  blue:   'bg-accent-blue/15  text-accent-blue',
  violet: 'bg-accent-violet/15 text-accent-violet',
  steel:  'bg-line          text-ink-muted'
} as const;

export function Badge({
  tone: t = 'steel', children, className
}: { tone?: keyof typeof tone; children: ReactNode; className?: string }) {
  return (
    <span className={clsx(
      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono font-medium',
      tone[t],
      className
    )}>{children}</span>
  );
}

export function ProbabilityBar({ value, label, tone: t = 'green' }:
  { value: number; label?: string; tone?: 'green' | 'amber' | 'red' | 'blue' }) {
  const pct = Math.round(value * 100);
  const colour = t === 'green'  ? 'bg-accent-green'
              : t === 'amber'  ? 'bg-accent-amber'
              : t === 'red'    ? 'bg-accent-red'
              :                  'bg-accent-blue';
  return (
    <div className="flex items-center gap-2">
      <div className="w-24 h-1.5 bg-bg-inset rounded">
        <div className={clsx(colour, 'h-1.5 rounded')} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] text-ink-muted font-mono w-9 text-right">{pct}%</span>
      {label && <span className="text-[11px] text-ink-dim">{label}</span>}
    </div>
  );
}
