import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { SetupCard } from '@/components/SetupCard';
import { getManagerId, getLeagueId } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  const managerId = getManagerId();
  const leagueId  = getLeagueId();
  const envManager = process.env.FPL_MANAGER_ID;
  const envLeague  = process.env.FPL_LEAGUE_ID;
  return (
    <div className="space-y-4">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Settings</div>
        <h1 className="text-2xl font-semibold">Session + environment</h1>
      </header>

      <Card title="Active session" subtitle="Set via the connection bar at the top; persisted in a cookie.">
        <ul className="text-sm font-mono space-y-1">
          <li>
            Manager ID (cookie): {managerId
              ? <Badge tone="green">{managerId}</Badge>
              : <Badge tone="amber">unset</Badge>}
          </li>
          <li>
            League ID (cookie): {leagueId
              ? <Badge tone="green">{leagueId}</Badge>
              : <Badge tone="amber">unset</Badge>}
          </li>
        </ul>
      </Card>

      <SetupCard prefillManager={managerId} />

      <Card title="Environment fallbacks" subtitle="Used by GitHub Actions cron + when no cookie is set.">
        <ul className="text-sm font-mono space-y-1">
          <li>FPL_MANAGER_ID: {envManager ? envManager : <Badge tone="steel">unset</Badge>}</li>
          <li>FPL_LEAGUE_ID:  {envLeague  ? envLeague  : <Badge tone="steel">unset</Badge>}</li>
          <li>EV_TRANSFER_THRESHOLD: {process.env.EV_TRANSFER_THRESHOLD ?? '0.6 (default)'}</li>
          <li>EV_HIT_THRESHOLD: {process.env.EV_HIT_THRESHOLD ?? '1.5 (default)'}</li>
          <li>ALLOW_USER_OPTIMISATION: {process.env.ALLOW_USER_OPTIMISATION ?? 'true (default)'}</li>
        </ul>
      </Card>

      <Card title="Operating principles">
        <ul className="text-sm text-ink-muted space-y-1">
          <li>· Cookies override env vars for the active session.</li>
          <li>· No ML / LLM in the decision path — every rule is inspectable.</li>
          <li>· Heavy optimisation only runs on manual trigger; results are cached.</li>
        </ul>
      </Card>
    </div>
  );
}
