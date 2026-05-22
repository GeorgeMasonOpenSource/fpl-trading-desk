/**
 * DecisionCard — the single visual primitive the new dashboard is built
 * from. One question, one answer, one action.
 *
 * Hierarchy:
 *   [eyebrow]              ← uppercase label, ink-dim
 *   [main]                 ← the answer, 24-32px, semibold
 *   [meta]                 ← supporting numbers, 11-12px mono
 *   [accent badge]         ← optional right-aligned, conveys conviction
 *   [details / progressive]← collapsible, hidden by default on mobile
 *
 * No bordered cards inside bordered cards. No tables on mobile. Generous
 * whitespace. The goal is one-screen decision-making, not data density.
 */
import { ReactNode } from 'react';

export function DecisionCard({
  eyebrow,
  main,
  meta,
  accent,
  details,
  href,
  tone = 'neutral'
}: {
  eyebrow: string;
  main: ReactNode;
  meta?: ReactNode;
  accent?: ReactNode;
  details?: ReactNode;
  href?: string;
  tone?: 'neutral' | 'positive' | 'negative' | 'warning';
}) {
  const ring = {
    neutral:  'ring-line/40',
    positive: 'ring-accent-green/40',
    negative: 'ring-accent-red/40',
    warning:  'ring-accent-amber/40'
  }[tone];

  const inner = (
    <article className={`rounded-2xl bg-bg-card ring-1 ${ring} p-5 transition-all hover:ring-2`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-[0.18em] text-ink-dim">{eyebrow}</div>
          <div className="mt-1.5 text-lg leading-tight font-semibold text-ink">{main}</div>
          {meta && (
            <div className="mt-1.5 text-[11px] font-mono text-ink-muted">{meta}</div>
          )}
        </div>
        {accent && <div className="shrink-0">{accent}</div>}
      </div>
      {details && (
        <details className="mt-4 group">
          <summary className="text-[11px] text-ink-dim cursor-pointer list-none select-none flex items-center gap-1.5 hover:text-ink-muted">
            <span className="inline-block w-3 group-open:rotate-90 transition-transform">›</span>
            <span>Details</span>
          </summary>
          <div className="mt-3 pl-4 text-[12px] text-ink-muted space-y-2 leading-relaxed">
            {details}
          </div>
        </details>
      )}
    </article>
  );
  return href ? <a href={href} className="block">{inner}</a> : inner;
}

/** Big accent number — used as the right-hand chip on decision cards. */
export function AccentNumber({
  value,
  unit,
  tone = 'positive'
}: { value: string; unit?: string; tone?: 'positive' | 'neutral' | 'warning' }) {
  const colour = tone === 'positive' ? 'text-accent-green'
    : tone === 'warning' ? 'text-accent-amber'
    : 'text-ink';
  return (
    <div className="text-right">
      <div className={`text-2xl leading-none font-semibold tabular-nums ${colour}`}>{value}</div>
      {unit && <div className="text-[9px] uppercase tracking-[0.15em] text-ink-dim mt-1">{unit}</div>}
    </div>
  );
}

/** Bottom nav grid for deeper pages. Single-tap large targets, mobile-first. */
export function NavGrid({ items }: {
  items: Array<{ href: string; label: string; sublabel?: string }>;
}) {
  return (
    <nav className="grid grid-cols-2 gap-2 pt-2">
      {items.map(it => (
        <a
          key={it.href}
          href={it.href}
          className="rounded-xl bg-bg-card/60 ring-1 ring-line/40 px-4 py-3.5 text-sm text-center hover:bg-bg-card hover:ring-line transition-colors"
        >
          <div className="font-medium text-ink">{it.label}</div>
          {it.sublabel && (
            <div className="text-[10px] text-ink-dim mt-0.5 uppercase tracking-widest">
              {it.sublabel}
            </div>
          )}
        </a>
      ))}
    </nav>
  );
}
