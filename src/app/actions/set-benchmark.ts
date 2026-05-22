'use server';
/**
 * Server action — record an external benchmark xPts for a player.
 *
 * Pastes FPLReview's (or another source's) projected xPts into the
 * benchmark-override table. The display layer blends it with our model
 * output at the configured weight (default 0.5).
 */
import { sql } from '@/lib/db/client';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

export async function setBenchmarkAction(formData: FormData) {
  const playerId = Number(formData.get('playerId'));
  const gameweekId = Number(formData.get('gameweekId'));
  const benchmarkXpts = Number(formData.get('benchmarkXpts'));
  const blendWeight = Number(formData.get('blendWeight') ?? 0.5);
  const source = String(formData.get('source') ?? 'fplreview').toLowerCase();

  if (!Number.isFinite(playerId) || playerId <= 0) throw new Error('Invalid playerId');
  if (!Number.isFinite(gameweekId) || gameweekId <= 0) throw new Error('Invalid gameweekId');
  if (!Number.isFinite(benchmarkXpts)) throw new Error('Invalid benchmarkXpts');
  const clampedWeight = Math.max(0, Math.min(1, blendWeight));

  await sql`
    INSERT INTO player_benchmark_overrides
      (player_id, gameweek_id, source, benchmark_xpts, blend_weight)
    VALUES
      (${playerId}, ${gameweekId}, ${source}, ${benchmarkXpts}, ${clampedWeight})
    ON CONFLICT (player_id, gameweek_id, source) DO UPDATE
      SET benchmark_xpts = EXCLUDED.benchmark_xpts,
          blend_weight   = EXCLUDED.blend_weight,
          updated_at     = now()
  `;
  revalidatePath('/model-audit');
  revalidatePath('/transfer-planner');
  revalidatePath('/');
  redirect(`/model-audit?q=${encodeURIComponent(String(formData.get('webName') ?? ''))}&gw=${gameweekId}`);
}

export async function clearBenchmarkAction(formData: FormData) {
  const playerId = Number(formData.get('playerId'));
  const gameweekId = Number(formData.get('gameweekId'));
  const source = String(formData.get('source') ?? 'fplreview').toLowerCase();
  await sql`
    DELETE FROM player_benchmark_overrides
     WHERE player_id = ${playerId}
       AND gameweek_id = ${gameweekId}
       AND source = ${source}
  `;
  revalidatePath('/model-audit');
  revalidatePath('/transfer-planner');
  revalidatePath('/');
  redirect(`/model-audit?q=${encodeURIComponent(String(formData.get('webName') ?? ''))}&gw=${gameweekId}`);
}
