import { NextRequest } from 'next/server';
import { sql, json } from '@/lib/db/client';
import { ok, fail } from '@/lib/util/auth';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  scope: z.enum(['player', 'team', 'fixture']),
  scopeId: z.number().int(),
  kind: z.string().min(1),
  value: z.unknown(),
  reason: z.string().optional(),
  expiresAt: z.string().optional()
});

export async function GET() {
  const rows = await sql`
    SELECT * FROM manual_overrides WHERE active = TRUE
    ORDER BY created_at DESC LIMIT 200
  `;
  return ok({ rows });
}

export async function POST(req: NextRequest) {
  const json = await req.json();
  const parsed = Body.safeParse(json);
  if (!parsed.success) return fail(parsed.error.message);
  const { scope, scopeId, kind, value, reason, expiresAt } = parsed.data;
  const [{ id }] = await sql<Array<{ id: number }>>`
    INSERT INTO manual_overrides (scope, scope_id, kind, value, reason, expires_at, active, created_at)
    VALUES (${scope}, ${scopeId}, ${kind}, ${json(value)},
            ${reason ?? null}, ${expiresAt ?? null}, TRUE, now())
    RETURNING id
  `;
  return ok({ id });
}

export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const id = Number(url.searchParams.get('id'));
  if (!id) return fail('id required');
  await sql`UPDATE manual_overrides SET active = FALSE WHERE id = ${id}`;
  return ok({ id });
}
