import { Badge } from './ui/Badge';

export function StaleDataWarning({
  lastIngest, thresholdHours = 24
}: { lastIngest: string | null; thresholdHours?: number }) {
  if (!lastIngest) {
    return (
      <div className="bg-accent-amber/10 border border-accent-amber/30 rounded-card p-3 flex items-center justify-between">
        <span className="text-sm text-accent-amber">No ingestion run yet — projections may be empty.</span>
        <Badge tone="amber">setup needed</Badge>
      </div>
    );
  }
  const ageHrs = (Date.now() - new Date(lastIngest).getTime()) / 36e5;
  if (ageHrs < thresholdHours) return null;
  return (
    <div className="bg-accent-amber/10 border border-accent-amber/30 rounded-card p-3 flex items-center justify-between">
      <span className="text-sm text-accent-amber">
        Data is {ageHrs.toFixed(1)}h old. Hit Refresh to re-ingest.
      </span>
      <Badge tone="amber">stale</Badge>
    </div>
  );
}
