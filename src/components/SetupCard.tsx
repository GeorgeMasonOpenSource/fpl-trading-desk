import { Card } from './ui/Card';
import { Badge } from './ui/Badge';
import { SubmitButton } from './SubmitButton';
import { connectManagerForm } from '@/app/actions/session';

/**
 * First-run setup card. Asks for an FPL manager ID and an optional classic
 * league ID, then runs the full ingestion + recompute server-side so the
 * dashboard works as soon as the form resolves.
 */
export function SetupCard({ prefillManager, prefillLeague }: {
  prefillManager?: number | null;
  prefillLeague?: number | null;
}) {
  return (
    <Card
      title="Connect your FPL team"
      subtitle="Find your manager ID under Pick Team → 'View gameweek history' — the number after /entry/ in the URL."
      action={<Badge tone="blue">setup</Badge>}
    >
      <form action={connectManagerForm} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field
            name="managerId"
            label="FPL Manager ID"
            placeholder="e.g. 1234567"
            required
            defaultValue={prefillManager ?? undefined}
          />
          <Field
            name="leagueId"
            label="Classic League ID (optional)"
            placeholder="e.g. 987654"
            defaultValue={prefillLeague ?? undefined}
          />
        </div>
        <div className="flex items-center justify-between">
          <p className="text-xs text-ink-dim max-w-md">
            We will fetch your squad, your league standings, and run the model.
            This takes about 5–15 seconds the first time. Nothing is submitted
            to FPL — read-only.
          </p>
          <SubmitButton>Connect &amp; ingest</SubmitButton>
        </div>
      </form>
    </Card>
  );
}

function Field({
  name, label, placeholder, defaultValue, required
}: {
  name: string; label: string; placeholder?: string;
  defaultValue?: number | string; required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-widest text-ink-dim">{label}</span>
      <input
        name={name}
        type="number"
        inputMode="numeric"
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue}
        className="mt-1 w-full bg-bg-inset border border-line rounded-md px-3 py-2 font-mono text-sm text-ink placeholder:text-ink-dim focus:outline-none focus:border-accent-blue"
      />
    </label>
  );
}
