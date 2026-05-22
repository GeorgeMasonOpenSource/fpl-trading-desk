'use server';
/**
 * Server action — persist which chips the user has already used. The chip
 * planner reads this and hides used chips so the recommendation is always
 * actionable.
 *
 * Why the redirect at the end:
 *   Without it, the checkbox UI doesn't update after submission. The
 *   <input defaultChecked={…}> only consults its prop on mount; React
 *   keeps the old DOM after Server Action revalidation. A full
 *   navigation (via redirect) re-mounts the form with the fresh cookie
 *   state. revalidatePath alone isn't enough.
 */
import { setUsedChips, type ChipCode } from '@/lib/session';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

export async function setChipsUsedAction(formData: FormData) {
  // formData has checkbox entries for each used chip.
  const codes: ChipCode[] = [];
  for (const c of ['WC', 'FH', 'BB', 'TC'] as ChipCode[]) {
    if (formData.get(c) === 'on') codes.push(c);
  }
  setUsedChips(codes);
  revalidatePath('/chip-planner');
  revalidatePath('/');
  redirect('/chip-planner?saved=1');
}
