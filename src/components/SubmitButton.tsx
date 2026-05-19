'use client';
import { useFormStatus } from 'react-dom';
import clsx from 'clsx';
import { ReactNode } from 'react';

/**
 * Form submit button that wires into React's useFormStatus so it can show
 * pending state for free in any server-action form.
 */
export function SubmitButton({
  children, className, variant = 'primary'
}: {
  children: ReactNode;
  className?: string;
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  const { pending } = useFormStatus();
  const base = 'inline-flex items-center justify-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const styles = {
    primary:   'bg-accent-green text-bg hover:bg-accent-green/90',
    secondary: 'bg-bg-inset text-ink hover:bg-line border border-line',
    danger:    'bg-accent-red/20 text-accent-red hover:bg-accent-red/30 border border-accent-red/40'
  };
  return (
    <button type="submit" disabled={pending} className={clsx(base, styles[variant], className)}>
      {pending && <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />}
      {pending ? 'Working…' : children}
    </button>
  );
}
