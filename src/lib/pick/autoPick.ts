/**
 * Auto-pick best Starting XI from a 15-player squad given xPts.
 *
 * Premier League formation rules (we honour all of them):
 *   - Exactly 1 GKP
 *   - 3..5 DEF
 *   - 2..5 MID
 *   - 1..3 FWD
 *   - 11 outfield + 1 GKP = 11 total
 *
 * Brute-force enumerate the legal (D, M, F) splits — there are only 9 — and
 * for each pick the top-N by xPts within each position. Pick the split with
 * the highest total xPts. Deterministic, < 1 ms.
 *
 * Bench order: the leftover 4 sorted by descending xPts (so the most-likely
 * auto-sub comes on first, exactly how FPL handles it).
 *
 * Captain: the highest-xPts starter. Vice: the second-highest.
 */
export interface AutoPickInput {
  player_id: number;
  web_name: string;
  pos: 'GKP' | 'DEF' | 'MID' | 'FWD';
  team_short: string;
  xpts_total: number;
  expected_minutes?: number;
  // anything else we want to carry forward to the view:
  [extra: string]: any;
}

export interface AutoPickedPlayer<T extends AutoPickInput> {
  player: T;
  slot: 'starter' | 'bench';
  benchOrder?: 1 | 2 | 3 | 4;    // 1 = GKP bench, 2..4 = outfield bench order
  isCaptain: boolean;
  isVice: boolean;
}

export interface AutoPickResult<T extends AutoPickInput> {
  formation: { def: number; mid: number; fwd: number };
  starters: AutoPickedPlayer<T>[];   // length 11, includes the GKP first
  bench:    AutoPickedPlayer<T>[];   // length 4
  totalXpts: number;
  captainXpts: number;               // doubled
}

const LEGAL_SPLITS: Array<[number, number, number]> = [
  // [DEF, MID, FWD] — every combination that totals 10 outfield with the
  // PL formation constraints.
  [3, 4, 3], [3, 5, 2], [4, 3, 3], [4, 4, 2], [4, 5, 1],
  [5, 2, 3], [5, 3, 2], [5, 4, 1]
];

export function autoPick<T extends AutoPickInput>(squad: T[]): AutoPickResult<T> {
  const byPos = {
    GKP: [...squad].filter(p => p.pos === 'GKP').sort((a, b) => b.xpts_total - a.xpts_total),
    DEF: [...squad].filter(p => p.pos === 'DEF').sort((a, b) => b.xpts_total - a.xpts_total),
    MID: [...squad].filter(p => p.pos === 'MID').sort((a, b) => b.xpts_total - a.xpts_total),
    FWD: [...squad].filter(p => p.pos === 'FWD').sort((a, b) => b.xpts_total - a.xpts_total)
  };

  // Validate we actually have a full squad. If not, fall back to as much as we have.
  const gkp = byPos.GKP[0];

  let best: { def: number; mid: number; fwd: number; total: number;
              starters: T[]; } | null = null;

  for (const [d, m, f] of LEGAL_SPLITS) {
    if (byPos.DEF.length < d || byPos.MID.length < m || byPos.FWD.length < f) continue;
    const starters = [
      ...(gkp ? [gkp] : []),
      ...byPos.DEF.slice(0, d),
      ...byPos.MID.slice(0, m),
      ...byPos.FWD.slice(0, f)
    ];
    const total = starters.reduce((s, p) => s + (Number(p.xpts_total) || 0), 0);
    if (!best || total > best.total) {
      best = { def: d, mid: m, fwd: f, total, starters };
    }
  }

  if (!best) {
    // Degenerate: just take everyone we have, no formation enforcement.
    const starters = [
      ...(gkp ? [gkp] : []),
      ...byPos.DEF, ...byPos.MID, ...byPos.FWD
    ].slice(0, 11);
    best = {
      def: byPos.DEF.length, mid: byPos.MID.length, fwd: byPos.FWD.length,
      total: starters.reduce((s, p) => s + (Number(p.xpts_total) || 0), 0),
      starters
    };
  }

  // Pick captain + vice from starters.
  const sortedStarters = [...best.starters].sort((a, b) => b.xpts_total - a.xpts_total);
  const captainId = sortedStarters[0]?.player_id;
  const viceId    = sortedStarters[1]?.player_id;

  const startedIds = new Set(best.starters.map(p => p.player_id));
  // FPL bench convention: slots 12/13/14 are outfield substitutes (auto-sub
  // priority order); slot 15 is the GKP (emergency only, only auto-subs
  // when starting GKP doesn't play). Map to our benchOrder space:
  //   benchOrder 1 → slot 12 (first outfield sub, highest auto-sub priority)
  //   benchOrder 2 → slot 13
  //   benchOrder 3 → slot 14
  //   benchOrder 4 → slot 15 (GKP)
  // Previously this was inverted — GKP was getting benchOrder=1 (highest
  // auto-sub priority) which is the opposite of FPL's actual behaviour.
  const benchGkp = byPos.GKP.find(p => !startedIds.has(p.player_id));
  const benchOutfield = [...byPos.DEF, ...byPos.MID, ...byPos.FWD]
    .filter(p => !startedIds.has(p.player_id))
    .sort((a, b) => b.xpts_total - a.xpts_total);

  const starters: AutoPickedPlayer<T>[] = best.starters.map(p => ({
    player: p,
    slot: 'starter',
    isCaptain: p.player_id === captainId,
    isVice: p.player_id === viceId
  }));
  const bench: AutoPickedPlayer<T>[] = [];
  let order = 1;
  for (const p of benchOutfield) {
    bench.push({
      player: p, slot: 'bench',
      benchOrder: order as 1 | 2 | 3 | 4,
      isCaptain: false, isVice: false
    });
    order++;
  }
  if (benchGkp) {
    // GKP always last (slot 15), regardless of how many outfielders are benched.
    bench.push({ player: benchGkp, slot: 'bench', benchOrder: 4, isCaptain: false, isVice: false });
  }

  const captainXpts = (sortedStarters[0]?.xpts_total ?? 0) * 2;
  return {
    formation: { def: best.def, mid: best.mid, fwd: best.fwd },
    starters,
    bench,
    totalXpts: best.total + (sortedStarters[0]?.xpts_total ?? 0), // captain doubled
    captainXpts
  };
}
