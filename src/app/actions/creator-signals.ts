'use server';
/**
 * Server actions for the Creator Board page.
 *
 * - acceptSignal: turn a pending signal into a manual_override (the only
 *   path by which creator commentary influences the projection engine).
 * - dismissSignal: hide it from the board.
 *
 * The model NEVER reads from transcript_signals directly — these actions
 * are the bridge that keeps the override chain deterministic and auditable.
 */
import { sql } from '@/lib/db/client';
import { revalidatePath } from 'next/cache';

type SignalKind =
  | 'start' | 'bench' | 'injury' | 'penalty' | 'setpiece'
  | 'recommend' | 'watching' | 'buying' | 'selling';

/** Translate a transcript signal kind into the manual_overrides shape. */
function toOverride(kind: SignalKind): { kind: string; value: any } | null {
  switch (kind) {
    case 'penalty':   return { kind: 'penalty_taker',  value: { share: 0.95 } };
    case 'setpiece':  return { kind: 'set_piece',      value: { share: 0.85 } };
    case 'start':     return { kind: 'availability',   value: { expected: 'start' } };
    case 'bench':     return { kind: 'availability',   value: { expected: 'bench' } };
    case 'injury':    return { kind: 'availability',   value: { expected: 'out' } };
    // Editorial kinds are recorded on the signal but don't auto-translate to
    // a model input — they're judgement calls, surfaced for the human to act
    // on via the transfer planner instead.
    case 'recommend':
    case 'watching':
    case 'buying':
    case 'selling':
      return null;
  }
}

export async function acceptSignal(formData: FormData) {
  const id = Number(formData.get('id'));
  if (!Number.isFinite(id)) return;

  // §2a: the Creator Board passes the model's verdict (agrees/neutral/
  // disagrees/no_data) alongside the accept. Persist on both the override
  // (so backtests can replay it) and the signal row (so future renders sort
  // and filter on it without re-deriving). Validate against the allow-list
  // before writing so a tampered form can't insert junk.
  const verdictRaw = String(formData.get('model_verdict') ?? '').trim();
  const ALLOWED_VERDICTS = new Set(['agrees', 'neutral', 'disagrees', 'no_data']);
  const modelVerdict = ALLOWED_VERDICTS.has(verdictRaw) ? verdictRaw : null;

  const sigRows = await sql<Array<{
    id: number; player_id: number; signal_kind: SignalKind;
    raw_quote: string; video_id: string;
  }>>`
    SELECT id, player_id, signal_kind, raw_quote, video_id
      FROM transcript_signals WHERE id = ${id}
  `;
  const sig = sigRows[0];
  if (!sig) return;

  const ov = toOverride(sig.signal_kind);
  if (ov) {
    // Requires migration 0007: adds manual_overrides.source, .notes,
    // .model_verdict_at_creation. Older deploys must run db:migrate first.
    const ins = await sql<Array<{ id: number }>>`
      INSERT INTO manual_overrides
        (scope, scope_id, kind, value, source, notes, model_verdict_at_creation, active, created_at)
      VALUES
        ('player', ${sig.player_id}, ${ov.kind},
         ${sql.json(ov.value as any)}, ${`youtube:${sig.video_id}`},
         ${sig.raw_quote}, ${modelVerdict}, TRUE, now())
      RETURNING id
    `;
    const overrideId = ins[0]?.id ?? null;
    await sql`
      UPDATE transcript_signals
         SET user_action          = 'accepted',
             reviewed_at          = now(),
             accepted_override_id = ${overrideId},
             model_verdict        = ${modelVerdict},
             model_verdict_at     = now()
       WHERE id = ${id}
    `;
  } else {
    // Editorial: mark accepted but no override created. Still cache the
    // verdict so the Creator Board doesn't have to re-derive it later, and
    // so it shows up in backtest replays of "which editorial calls landed".
    await sql`
      UPDATE transcript_signals
         SET user_action      = 'accepted',
             reviewed_at      = now(),
             model_verdict    = ${modelVerdict},
             model_verdict_at = now()
       WHERE id = ${id}
    `;
  }
  revalidatePath('/creator-signals');
  revalidatePath('/', 'layout');
}

export async function dismissSignal(formData: FormData) {
  const id = Number(formData.get('id'));
  if (!Number.isFinite(id)) return;
  await sql`
    UPDATE transcript_signals
       SET user_action = 'dismissed', reviewed_at = now()
     WHERE id = ${id}
  `;
  revalidatePath('/creator-signals');
}
