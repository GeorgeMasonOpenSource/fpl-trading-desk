import type { TransferReason } from '@/lib/transfers/transfer-reasons';

/**
 * Render the reasoned-bullets block for a transfer suggestion.
 * Positives get a green dot, neutrals a steel dot, negatives an amber dot
 * so the user can skim and see how many trade-offs vs wins there are at a
 * glance. Each row has a bold headline + a data-backed sentence.
 *
 * This is the "why" — sits above the raw data tables (TransferWhy) and the
 * EV decomposition bar, so the user reads the model's argument first, then
 * verifies in the data below.
 */
export function TransferReasons({ reasons }: { reasons: TransferReason[] }) {
  if (reasons.length === 0) {
    return (
      <div className="text-xs text-ink-dim italic">
        No standout reasons — this swap is a marginal model preference. Consider rolling.
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] uppercase tracking-widest text-ink-dim">
        Why this swap
      </div>
      <ul className="space-y-1.5">
        {reasons.map((r, idx) => (
          <li key={idx} className="flex items-start gap-2.5 text-xs">
            <span
              aria-hidden
              className={`mt-1 inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
                r.tone === 'positive' ? 'bg-accent-green' :
                r.tone === 'negative' ? 'bg-accent-amber' :
                                        'bg-ink-dim'
              }`}
            />
            <span>
              <span className={`font-medium ${
                r.tone === 'positive' ? 'text-accent-green' :
                r.tone === 'negative' ? 'text-accent-amber' :
                                        'text-ink'
              }`}>
                {r.headline}
              </span>
              <span className="text-ink-muted"> — {r.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
