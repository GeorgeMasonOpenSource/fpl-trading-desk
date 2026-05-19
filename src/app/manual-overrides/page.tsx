import { Card } from '@/components/ui/Card';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { OverrideForm } from '@/components/OverrideForm';
import { SubmitButton } from '@/components/SubmitButton';
import { disableOverride } from '@/app/actions/overrides';
import { sql } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ManualOverridesPage() {
  const rows = await sql<any[]>`
    SELECT id, scope, scope_id, kind, value, reason, active, created_at, expires_at
    FROM manual_overrides ORDER BY created_at DESC LIMIT 200
  `;
  return (
    <div className="space-y-4">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Manual overrides</div>
        <h1 className="text-2xl font-semibold">Structured factual overrides</h1>
        <p className="text-sm text-ink-muted mt-1">
          The model still decides the output — these adjust its inputs.
        </p>
      </header>
      <OverrideForm />
      <Card title="Active + historical overrides">
        <Table>
          <THead>
            <TH>ID</TH><TH>Scope</TH><TH>ScopeID</TH><TH>Kind</TH><TH>Value</TH><TH>Reason</TH>
            <TH>Active</TH><TH>Expires</TH><TH>{' '}</TH>
          </THead>
          <tbody>
            {rows.map((r: any) => (
              <TR key={r.id}>
                <TD className="font-mono text-xs">{r.id}</TD>
                <TD><Badge tone="blue">{r.scope}</Badge></TD>
                <TD className="font-mono">{r.scope_id}</TD>
                <TD><Badge tone="violet">{r.kind}</Badge></TD>
                <TD className="font-mono text-xs">{JSON.stringify(r.value)}</TD>
                <TD className="text-xs">{r.reason}</TD>
                <TD>{r.active ? <Badge tone="green">on</Badge> : <Badge tone="steel">off</Badge>}</TD>
                <TD className="text-xs text-ink-muted">{r.expires_at?.toString?.().slice(0,19) ?? '—'}</TD>
                <TD>
                  {r.active && (
                    <form action={disableOverride}>
                      <input type="hidden" name="id" value={r.id} />
                      <SubmitButton variant="danger" className="!px-2 !py-0.5 !text-xs">Disable</SubmitButton>
                    </form>
                  )}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
