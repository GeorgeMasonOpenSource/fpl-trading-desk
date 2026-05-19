'use server';

/**
 * Server actions for the manual override system.
 * Structured factual overrides only — never opinion-based recommendations.
 */
import { revalidatePath } from 'next/cache';
import { sql, json } from '@/lib/db/client';

export interface OverrideResult { ok: boolean; id?: number; error?: string }

/** Generic override insert. The "kind" determines which slot of the model it feeds. */
export async function addOverride(formData: FormData): Promise<OverrideResult> {
  const scope = String(formData.get('scope') ?? '').trim() as 'player' | 'team' | 'fixture';
  const scopeId = Number(formData.get('scopeId'));
  const kind = String(formData.get('kind') ?? '').trim();
  const valueRaw = String(formData.get('value') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim() || null;
  if (!['player', 'team', 'fixture'].includes(scope)) return { ok: false, error: 'Bad scope.' };
  if (!Number.isFinite(scopeId) || scopeId <= 0) return { ok: false, error: 'Bad scope id.' };
  if (!kind) return { ok: false, error: 'Missing kind.' };

  let value: unknown;
  // Accept either raw JSON ("{ \"share\": 0.95 }") or a simple "key=value" string.
  try {
    value = valueRaw.startsWith('{') ? JSON.parse(valueRaw) : { value: valueRaw };
  } catch {
    return { ok: false, error: 'Value must be valid JSON or a plain string.' };
  }
  try {
    const rows = await sql<Array<{ id: number }>>`
      INSERT INTO manual_overrides (scope, scope_id, kind, value, reason, active, created_at)
      VALUES (${scope}, ${scopeId}, ${kind}, ${json(value)}, ${reason}, TRUE, now())
      RETURNING id
    `;
    revalidatePath('/manual-overrides');
    revalidatePath('/');
    return { ok: true, id: rows[0]?.id };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Void wrapper for use as `<form action={...}>`. */
export async function addOverrideForm(formData: FormData) {
  const r = await addOverride(formData);
  if (!r.ok) console.error('[addOverride]', r.error);
}

export async function disableOverride(formData: FormData) {
  const id = Number(formData.get('id'));
  if (!Number.isFinite(id) || id <= 0) return;
  await sql`UPDATE manual_overrides SET active = FALSE WHERE id = ${id}`;
  revalidatePath('/manual-overrides');
  revalidatePath('/');
}
