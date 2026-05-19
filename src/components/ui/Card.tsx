import { ReactNode } from 'react';
import clsx from 'clsx';

export function Card({
  title, subtitle, action, children, className
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx('bg-bg-card border border-line rounded-card', className)}>
      {(title || action) && (
        <header className="flex items-baseline justify-between px-4 py-3 border-b border-line">
          <div>
            {title && <h3 className="text-sm font-semibold tracking-wide">{title}</h3>}
            {subtitle && <p className="text-xs text-ink-muted mt-0.5">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}
