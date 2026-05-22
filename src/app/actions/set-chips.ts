'use server';
/**
 * Server action — persist which chips the user has already used. The chip
 * planner reads this and hides used chips so the recommendation is always
 * actionable.
 */
import { setUsedChips, type ChipCode } from '@/lib/session';
import { revalidatePath } from 'next/cache';

export async function setChipsUsedAction(formData: FormData) {
  // formData has checkbox entries for each used chip.
  const codes: ChipCode[] = [];
  for (const c of ['WC', 'FH', 'BB', 'TC'] as ChipCode[]) {
    if (formData.get(c) === 'on') codes.push(c);
  }
  setUsedChips(codes);
  revalidatePath('/chip-planner');
  revalidatePath('/');
}
