/**
 * Type-only file for the compare-swap server action.
 *
 * WHY THIS FILE EXISTS:
 *   Next.js 14 enforces that any file with the `'use server'` directive can
 *   only export async functions (the Server Actions). Exporting interfaces,
 *   constants, or anything non-function from a `'use server'` file causes
 *   `next build` to fail with "A "use server" file can only export async
 *   functions". `tsc --noEmit` does not catch this — it's a Next compiler
 *   rule, not a TypeScript one — so we discovered it on Vercel.
 *
 *   We keep the shared types here, import them from both the action and the
 *   client component, and the action file re-exports nothing.
 */
import type { EvComponents, PerGwDelta, PlayerInsight } from '@/lib/transfers/insights';

export interface CompareSwapPlayer {
  playerId: number;
  webName: string;
  position: 'GKP' | 'DEF' | 'MID' | 'FWD';
  teamShort: string;
  nowCost: number;
}

export interface CompareSwapMatch {
  query: string;
  candidates: CompareSwapPlayer[];
}

export interface CompareSwapResult {
  ok: boolean;
  error?: string;
  source?: string;                 // e.g. "FPL Review" if the input had a label
  outResolved?: CompareSwapPlayer;
  inResolved?: CompareSwapPlayer;
  ambiguities?: CompareSwapMatch[];
  delta?: EvComponents;
  perGw?: PerGwDelta[];
  netEv?: number;
  // §detailed-breakdown — absolute per-component xPts so the UI can
  // render the same side-by-side breakdown table used for the top-N
  // rows. Also includes the player insight + expected minutes the
  // formula columns need.
  outComponents?: EvComponents;
  inComponents?:  EvComponents;
  outInsight?:    PlayerInsight;
  inInsight?:     PlayerInsight;
  outExpectedMinutes?: number | null;
  inExpectedMinutes?:  number | null;
  horizonGws?: number;
}
