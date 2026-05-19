import Link from 'next/link';
import { Card } from './ui/Card';
import { Badge } from './ui/Badge';

/** Shown on any page that needs a connected manager ID. */
export function NotConnected({ where }: { where: string }) {
  return (
    <Card
      title={`${where} needs a connected manager`}
      action={<Badge tone="amber">not connected</Badge>}
    >
      <p className="text-sm text-ink-muted">
        Open the <Link href="/" className="text-accent-blue hover:underline">Dashboard</Link> and
        enter your FPL Manager ID, then come back here.
      </p>
    </Card>
  );
}
