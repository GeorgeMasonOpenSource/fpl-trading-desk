import clsx from 'clsx';
import { ReactNode } from 'react';

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('overflow-x-auto', className)}>
      <table className="min-w-full text-sm font-tabular">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead>
      <tr className="text-[11px] text-ink-dim uppercase tracking-widest text-left">{children}</tr>
    </thead>
  );
}

export function TH({ children, className }: { children: ReactNode; className?: string }) {
  return <th className={clsx('px-2 py-2 font-medium border-b border-line', className)}>{children}</th>;
}

export function TR({ children, className }: { children: ReactNode; className?: string }) {
  return <tr className={clsx('border-b border-line hover:bg-bg-raised', className)}>{children}</tr>;
}

export function TD({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={clsx('px-2 py-2 align-middle', className)}>{children}</td>;
}
