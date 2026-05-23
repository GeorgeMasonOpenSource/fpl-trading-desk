import { autoPick, type AutoPickInput, type AutoPickResult } from './autoPick';

/**
 * XI narrative.
 *
 * Given a 15-player squad with xPts, produce three things:
 *
 *   1. The recommended XI (formation + 11 names) — already done by `autoPick`.
 *   2. A formation-level explanation: WHY this formation (e.g. 3-4-3)
 *      beat its closest legal alternative (e.g. 3-5-2). Frames it as
 *      "+0.42 xP by playing your 3rd FWD over your 5th MID".
 *   3. Per-starter reasoning: WHY this player is starting over the nearest
 *      bench alternative in the same position. Always xP-anchored. If the
 *      gap is small (<0.3 xP), flag it as a close call so the user knows
 *      to read team-news before locking in.
 *
 * Everything is deterministic from the squad's xPts numbers — no hidden
 * model state. If the user disagrees with a recommendation they can read
 * the math and override.
 */

export interface XiFormationRunnerUp {
  formation: { def: number; mid: number; fwd: number };
  totalXpts: number;
  gap: number;            // best - runner-up; positive
  swapDescription: string; // "playing your 3rd FWD (4.20) over your 5th MID (3.78)"
}

export interface XiStarterReason {
  player_id: number;
  isCaptain: boolean;
  isVice: boolean;
  xpts: number;
  /** The bench player closest in xP at the same position (or null if none). */
  nearestBenchAlternative: {
    player_id: number;
    web_name: string;
    xpts: number;
  } | null;
  /** starter xP - nearest-alt xP. Negative means the bench guy is HIGHER xP (rare — happens with formation forcing). */
  xpGap: number;
  /** 3-6 bullets, same shape as transfer-reasons. */
  bullets: XiBullet[];
}

export interface XiBullet {
  tone: 'positive' | 'neutral' | 'negative';
  headline: string;
  detail: string;
}

export interface XiNarrative<T extends AutoPickInput> {
  pick: AutoPickResult<T>;
  formation: { def: number; mid: number; fwd: number };
  /** The next-best legal formation we didn't pick, with the xP gap. */
  runnerUpFormation: XiFormationRunnerUp | null;
  /** One reasons entry per starter, in the same order as pick.starters. */
  starterReasons: XiStarterReason[];
}

const LEGAL_SPLITS: Array<[number, number, number]> = [
  [3, 4, 3], [3, 5, 2], [4, 3, 3], [4, 4, 2], [4, 5, 1],
  [5, 2, 3], [5, 3, 2], [5, 4, 1]
];

export function explainXi<T extends AutoPickInput>(squad: T[]): XiNarrative<T> {
  const pick = autoPick(squad);

  // Re-derive position-sorted lists so we can find runners-up + nearest alts.
  const byPos = {
    GKP: squad.filter(p => p.pos === 'GKP').sort((a, b) => b.xpts_total - a.xpts_total),
    DEF: squad.filter(p => p.pos === 'DEF').sort((a, b) => b.xpts_total - a.xpts_total),
    MID: squad.filter(p => p.pos === 'MID').sort((a, b) => b.xpts_total - a.xpts_total),
    FWD: squad.filter(p => p.pos === 'FWD').sort((a, b) => b.xpts_total - a.xpts_total)
  };

  // Runner-up formation. Enumerate all legal splits we can fill, score each,
  // pick the second-best by total starting xP (excluding the chosen one).
  const chosen = pick.formation;
  let runnerUp: XiFormationRunnerUp | null = null;
  let runnerUpTotal = -Infinity;
  for (const [d, m, f] of LEGAL_SPLITS) {
    if (d === chosen.def && m === chosen.mid && f === chosen.fwd) continue;
    if (byPos.DEF.length < d || byPos.MID.length < m || byPos.FWD.length < f) continue;
    const total =
      (byPos.GKP[0]?.xpts_total ?? 0) +
      byPos.DEF.slice(0, d).reduce((s, p) => s + p.xpts_total, 0) +
      byPos.MID.slice(0, m).reduce((s, p) => s + p.xpts_total, 0) +
      byPos.FWD.slice(0, f).reduce((s, p) => s + p.xpts_total, 0);
    if (total > runnerUpTotal) {
      runnerUpTotal = total;
      // Identify the swap that converts runner-up → chosen.
      const swap = describeFormationSwap(byPos, { def: d, mid: m, fwd: f }, chosen);
      runnerUp = {
        formation: { def: d, mid: m, fwd: f },
        totalXpts: total,
        gap: (pick.totalXpts - (sortedStartersCaptainBonus(pick))) - total,  // strip the captain doubling for an apples-to-apples comparison
        swapDescription: swap
      };
    }
  }

  // Per-starter reasons.
  const starterReasons: XiStarterReason[] = pick.starters.map(s => {
    const p = s.player;
    // Nearest bench alt at the same position is just the highest-xPts bench player in the same pos.
    const pos = p.pos as 'GKP'|'DEF'|'MID'|'FWD';
    const nearest = pick.bench
      .map(b => b.player)
      .filter(b => (b.pos as string) === pos)
      .sort((a, b) => b.xpts_total - a.xpts_total)[0] ?? null;

    const gap = nearest ? p.xpts_total - nearest.xpts_total : p.xpts_total;
    const bullets = startBullets(p, nearest, gap, s.isCaptain, s.isVice);

    return {
      player_id: p.player_id,
      isCaptain: s.isCaptain,
      isVice: s.isVice,
      xpts: p.xpts_total,
      nearestBenchAlternative: nearest ? {
        player_id: nearest.player_id,
        web_name: nearest.web_name,
        xpts: nearest.xpts_total
      } : null,
      xpGap: gap,
      bullets
    };
  });

  return {
    pick,
    formation: pick.formation,
    runnerUpFormation: runnerUp,
    starterReasons
  };
}

function sortedStartersCaptainBonus<T extends AutoPickInput>(pick: AutoPickResult<T>): number {
  // pick.totalXpts includes the captain doubled. To compare formations apples-to-apples,
  // strip that bonus (max starter xPts).
  const max = Math.max(...pick.starters.map(s => s.player.xpts_total), 0);
  return max;
}

/**
 * Build the per-starter bullets. Always lead with the xP gap framed in
 * the user's language ("starting because you'll gain X xP over your nearest
 * bench alt"). Then add minutes/role/fixture context if they exist.
 */
function startBullets(
  p: AutoPickInput,
  nearest: AutoPickInput | null,
  gap: number,
  isCaptain: boolean,
  isVice: boolean
): XiBullet[] {
  const out: XiBullet[] = [];

  // 1. The xP gap — the headline reason. Tone depends on the size.
  if (nearest) {
    if (gap >= 1.5) {
      out.push({
        tone: 'positive',
        headline: `+${gap.toFixed(2)} xP over ${nearest.web_name}`,
        detail: `Projected ${p.xpts_total.toFixed(2)} xP vs ${nearest.web_name} on the bench at ${nearest.xpts_total.toFixed(2)}. Clear start — no debate.`
      });
    } else if (gap >= 0.5) {
      out.push({
        tone: 'positive',
        headline: `+${gap.toFixed(2)} xP edge`,
        detail: `Beats ${nearest.web_name} (${nearest.xpts_total.toFixed(2)} xP) by ${gap.toFixed(2)}. Decent margin — model is confident.`
      });
    } else if (gap >= 0) {
      out.push({
        tone: 'neutral',
        headline: `Close call: +${gap.toFixed(2)} xP`,
        detail: `Only ${gap.toFixed(2)} xP ahead of ${nearest.web_name} (${nearest.xpts_total.toFixed(2)}). Read team news — if ${p.web_name} is doubtful, ${nearest.web_name} is the safer pick.`
      });
    } else {
      // gap < 0 means the bench player has HIGHER xP — only happens when formation
      // forcing requires us to play e.g. a 5th DEF whose xP is below the bench MID.
      out.push({
        tone: 'negative',
        headline: `Forced start: ${Math.abs(gap).toFixed(2)} xP behind ${nearest.web_name}`,
        detail: `${nearest.web_name} is projected higher (${nearest.xpts_total.toFixed(2)} vs ${p.xpts_total.toFixed(2)}) but formation rules force this slot. Could swap formation if the gap matters.`
      });
    }
  } else {
    // No bench alternative at this position — usually means GKP with no backup logic.
    out.push({
      tone: 'positive',
      headline: `Locked starter`,
      detail: `Projected ${p.xpts_total.toFixed(2)} xP. No bench alternative at ${p.pos}.`
    });
  }

  // 2. Minutes secure — only flag if the data is on the player object (carried
  //    through by `toCard`). Otherwise skip.
  const em = Number(p.expected_minutes);
  if (Number.isFinite(em) && em > 0) {
    if (em >= 80) {
      out.push({
        tone: 'positive',
        headline: 'Nailed for 80+ mins',
        detail: `Minutes engine forecasts ${em.toFixed(0)} expected mins — full appearance, no rotation risk in the model.`
      });
    } else if (em < 60) {
      out.push({
        tone: 'negative',
        headline: 'Rotation risk',
        detail: `Minutes engine forecasts only ${em.toFixed(0)} mins — could miss the appearance bonus. If ${nearest?.web_name ?? 'bench'} is nailed, consider swapping.`
      });
    }
  }

  // 3. Captain / vice flag.
  if (isCaptain) {
    out.push({
      tone: 'positive',
      headline: 'Auto-captain (×2)',
      detail: `Highest xP in the XI — armband doubles to ${(p.xpts_total * 2).toFixed(2)} expected points.`
    });
  } else if (isVice) {
    out.push({
      tone: 'neutral',
      headline: 'Vice-captain',
      detail: `2nd-highest xP — picks up the armband if the captain doesn't play.`
    });
  }

  return out.slice(0, 5);
}

/**
 * Describe the marginal swap between two formations. We say it in the form
 * "playing your Nth POS (xP) over your Mth POS (xP)" so the user understands
 * which specific player drives the formation choice.
 */
function describeFormationSwap(
  byPos: { GKP: AutoPickInput[]; DEF: AutoPickInput[]; MID: AutoPickInput[]; FWD: AutoPickInput[] },
  from: { def: number; mid: number; fwd: number },
  to:   { def: number; mid: number; fwd: number }
): string {
  // The diff identifies which position gained a slot and which lost one.
  const gained: Array<'DEF'|'MID'|'FWD'> = [];
  const lost:   Array<'DEF'|'MID'|'FWD'> = [];
  if (to.def > from.def) gained.push('DEF'); else if (to.def < from.def) lost.push('DEF');
  if (to.mid > from.mid) gained.push('MID'); else if (to.mid < from.mid) lost.push('MID');
  if (to.fwd > from.fwd) gained.push('FWD'); else if (to.fwd < from.fwd) lost.push('FWD');
  if (gained.length === 0 || lost.length === 0) return 'same player pool, different formation';

  // Single 1-for-1 swap is the common case.
  if (gained.length === 1 && lost.length === 1) {
    const g = gained[0]!;
    const l = lost[0]!;
    const newSlot = to[posKey(g)];
    const droppedSlot = from[posKey(l)];
    const newPlayer = byPos[g][newSlot - 1];
    const droppedPlayer = byPos[l][droppedSlot - 1];
    if (!newPlayer || !droppedPlayer) return 'formation swap';
    const xpGain = newPlayer.xpts_total - droppedPlayer.xpts_total;
    return `playing your ${ord(newSlot)} ${g} ${newPlayer.web_name} (${newPlayer.xpts_total.toFixed(2)} xP) over your ${ord(droppedSlot)} ${l} ${droppedPlayer.web_name} (${droppedPlayer.xpts_total.toFixed(2)} xP) — ${xpGain >= 0 ? '+' : ''}${xpGain.toFixed(2)} xP swing`;
  }
  return `${gained.join('+')} over ${lost.join('+')}`;
}

function posKey(p: 'DEF'|'MID'|'FWD'): 'def'|'mid'|'fwd' {
  return p === 'DEF' ? 'def' : p === 'MID' ? 'mid' : 'fwd';
}

function ord(n: number): string {
  if (n === 1) return '1st';
  if (n === 2) return '2nd';
  if (n === 3) return '3rd';
  return `${n}th`;
}
