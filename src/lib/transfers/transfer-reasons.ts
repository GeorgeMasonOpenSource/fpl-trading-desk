import type { PlayerInsight, EvComponents, PerGwDelta } from './insights';
import type { Position } from '@/lib/db/types';

/**
 * Transfer reasoner.
 *
 * Given everything we already know about an OUT/IN pair — recent form,
 * upcoming fixtures, set-piece roles, the EV decomposition, captain change —
 * produce a ranked list of plain-English bullets that explain WHY the model
 * is suggesting this swap, with the actual numbers attached.
 *
 * Design rules:
 *   - Every bullet must reference a specific data point. Vague claims like
 *     "good form" without a number are banned.
 *   - Positives come first, then neutrals, then trade-offs/negatives. The
 *     user reads top-down, so the most compelling argument is first.
 *   - Cap at 6 bullets. More than that and the user stops reading.
 *   - Bullets are computed in the order the model "thinks" about them:
 *     form gap → minutes security → underlying threat → fixtures →
 *     set-piece role → captain change → EV driver → cost → bench warning.
 *
 * The numbers come straight from `getTransferInsights` (recent.*, season.*,
 * upcoming.*, roles.*) and `getTransferEvBreakdown` (the per-component delta).
 * Nothing is fabricated — if the data isn't there, the bullet is skipped.
 */

export interface TransferReason {
  /** 'positive' = argument FOR the swap, 'negative' = trade-off, 'neutral' = context. */
  tone: 'positive' | 'negative' | 'neutral';
  /** 2–4 word headline shown in bold. */
  headline: string;
  /** Plain-English sentence with the supporting numbers. */
  detail: string;
}

export interface TransferReasonsInput {
  outName: string;
  inName: string;
  outInsight?: PlayerInsight;
  inInsight?: PlayerInsight;
  componentDelta?: EvComponents | null;
  perGw?: PerGwDelta[];
  /** Net spend in tenths (positive = costs more, negative = frees cash). */
  netCost: number;
  evGain1: number;
  evGain3: number;
  changesCaptain: boolean;
  /** True if the incoming player would be in the auto-picked XI after the swap. */
  startsImmediately: boolean;
  position: Position;
}

export function transferReasons(input: TransferReasonsInput): TransferReason[] {
  const out: TransferReason[] = [];
  const i = input.inInsight;
  const o = input.outInsight;

  // 1. Recent attacking returns. The single most-trusted signal — if your
  //    incoming player is scoring/assisting and the outgoing isn't, that's
  //    the headline.
  if (i && o) {
    const inReturns = i.recent.goals + i.recent.assists;
    const outReturns = o.recent.goals + o.recent.assists;
    if (inReturns - outReturns >= 2) {
      out.push({
        tone: 'positive',
        headline: 'In-form vs cold',
        detail: `${input.inName}: ${inReturns} return${inReturns === 1 ? '' : 's'} in last ${i.recent.apps} (${i.recent.goals}G ${i.recent.assists}A). ${input.outName}: ${outReturns} in ${o.recent.apps} (${o.recent.goals}G ${o.recent.assists}A).`
      });
    } else if (inReturns >= 3 && i.recent.apps >= 3) {
      out.push({
        tone: 'positive',
        headline: 'Hot streak',
        detail: `${inReturns} attacking return${inReturns === 1 ? '' : 's'} in last ${i.recent.apps} played (${i.recent.goals}G ${i.recent.assists}A, ${i.recent.bonus} bonus).`
      });
    }
  }

  // 2. Minutes security. The point you score is multiplied by how often
  //    you actually start, so a 75-min nailed starter beats a 90-min
  //    rotation risk every time.
  if (i && o) {
    const inMinPerApp = i.recent.apps > 0 ? i.recent.minutes / i.recent.apps : 0;
    const outMinPerApp = o.recent.apps > 0 ? o.recent.minutes / o.recent.apps : 0;
    if (i.recent.apps >= 3 && inMinPerApp - outMinPerApp >= 15) {
      out.push({
        tone: 'positive',
        headline: 'Minutes secure',
        detail: `${inMinPerApp.toFixed(0)} mins/app over last ${i.recent.apps} (vs ${outMinPerApp.toFixed(0)} for ${input.outName} across ${o.recent.apps}).`
      });
    } else if (i.recent.apps >= 4 && i.recent.starts === i.recent.apps && inMinPerApp >= 80) {
      out.push({
        tone: 'positive',
        headline: 'Nailed starter',
        detail: `Started all ${i.recent.apps} most recent — averaging ${inMinPerApp.toFixed(0)} mins. No rotation risk.`
      });
    } else if (o && outMinPerApp > 0 && outMinPerApp < 60) {
      out.push({
        tone: 'positive',
        headline: 'Out is rotation risk',
        detail: `${input.outName} only averaging ${outMinPerApp.toFixed(0)} mins/app last ${o.recent.apps} — that's below the 60-min appearance threshold.`
      });
    }
  }

  // 3. Underlying threat — xG + xA over the recent window. xG above goals
  //    means the goals are coming; xG below means the form was lucky.
  if (i && o) {
    const inXgi = i.recent.xg + i.recent.xa;
    const outXgi = o.recent.xg + o.recent.xa;
    if (inXgi - outXgi >= 0.7) {
      out.push({
        tone: 'positive',
        headline: 'Underlying threat',
        detail: `Generating ${i.recent.xg.toFixed(1)} xG + ${i.recent.xa.toFixed(1)} xA over last ${i.recent.apps}. ${input.outName}: ${o.recent.xg.toFixed(1)}+${o.recent.xa.toFixed(1)}.`
      });
    }
  }

  // 4. Fixture swing. FDR is FPL's 1–5 difficulty rating; <2.5 is a green
  //    run, >3.5 is a hard run. A 1.0 swing across 3 GWs is significant.
  if (i && o && i.upcoming.length > 0 && o.upcoming.length > 0) {
    const inFdr = i.upcoming.reduce((s, f) => s + f.fdr, 0) / i.upcoming.length;
    const outFdr = o.upcoming.reduce((s, f) => s + f.fdr, 0) / o.upcoming.length;
    const inFx = i.upcoming.map(f => `${f.opp}${f.home ? '(H)' : '(A)'}`).join(', ');
    if (outFdr - inFdr >= 0.7) {
      out.push({
        tone: 'positive',
        headline: 'Easier fixtures',
        detail: `Next 3: ${inFx}. Avg FDR ${inFdr.toFixed(1)} vs ${outFdr.toFixed(1)} for ${input.outName}.`
      });
    } else if (inFdr - outFdr >= 0.7) {
      out.push({
        tone: 'negative',
        headline: 'Tougher fixtures',
        detail: `Next 3: ${inFx}. Avg FDR ${inFdr.toFixed(1)} — actually harder than ${input.outName} (${outFdr.toFixed(1)}). The recommendation rides on form, not fixtures.`
      });
    }
  }

  // 5. Set-piece role. Penalty takers earn ~2 extra goals/season and corners
  //    add a chance-creation bump that doesn't show in headline stats.
  if (i && o) {
    const inPen = i.roles.penaltyOrder;
    const outPen = o.roles.penaltyOrder;
    if (inPen && inPen <= 2 && (!outPen || outPen > 2)) {
      out.push({
        tone: 'positive',
        headline: 'Penalty taker',
        detail: `${input.inName} is on penalties (#${inPen}). ${input.outName} ${outPen ? `is #${outPen}` : 'is not on penalties'}.`
      });
    } else if (!inPen || inPen > 2) {
      const sp: string[] = [];
      if (i.roles.cornersOrder && i.roles.cornersOrder <= 2) sp.push(`corners #${i.roles.cornersOrder}`);
      if (i.roles.freekicksOrder && i.roles.freekicksOrder <= 2) sp.push(`FK #${i.roles.freekicksOrder}`);
      if (sp.length > 0) {
        out.push({
          tone: 'neutral',
          headline: 'Set-piece role',
          detail: `Takes ${sp.join(', ')} — extra chance creation that compounds across the horizon.`
        });
      }
    }
    // Pen-taker loss is a real warning the user should see.
    if (outPen && outPen === 1 && (!inPen || inPen >= 2)) {
      out.push({
        tone: 'negative',
        headline: 'Losing pen #1',
        detail: `${input.outName} is the #1 penalty taker — you'd give up that source of goals.`
      });
    }
  }

  // 6. Captain change. Worth a bullet because it's the highest-leverage
  //    decision in the gameweek and the user may not realise the swap
  //    changes who the auto-captain will be.
  if (input.changesCaptain) {
    out.push({
      tone: 'positive',
      headline: 'Becomes new captain',
      detail: `${input.inName} would be the new auto-captain — armband doubles his projected points next GW.`
    });
  }

  // 7. EV driver — which component of the projection actually moved.
  //    Useful when none of the above is obvious; tells the user "this is
  //    a defcon play" or "this is a bonus-points play".
  if (input.componentDelta) {
    const components: Array<{ name: string; value: number }> = [
      { name: 'goal threat',  value: input.componentDelta.goals      },
      { name: 'assists',      value: input.componentDelta.assists    },
      { name: 'clean sheets', value: input.componentDelta.cleanSheet },
      { name: 'bonus',        value: input.componentDelta.bonus      },
      { name: 'defcon',       value: input.componentDelta.defcon     },
      { name: 'appearances',  value: input.componentDelta.appearance }
    ];
    const driver = components.sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0];
    if (driver && Math.abs(driver.value) >= 0.3) {
      // Skip if we already have a bullet covering this signal (form, fixtures, etc).
      const headlinesSoFar = out.map(r => r.headline.toLowerCase()).join('|');
      const dup =
        (driver.name === 'goal threat' && /in-form|hot streak|threat/.test(headlinesSoFar)) ||
        (driver.name === 'assists'     && /in-form|threat/.test(headlinesSoFar)) ||
        (driver.name === 'clean sheets' && /fixtures/.test(headlinesSoFar));
      if (!dup) {
        out.push({
          tone: driver.value > 0 ? 'positive' : 'negative',
          headline: driver.value > 0 ? `Bigger ${driver.name}` : `Loses ${driver.name}`,
          detail: `${driver.value > 0 ? '+' : ''}${driver.value.toFixed(2)} EV from ${driver.name} alone over the horizon.`
        });
      }
    }
  }

  // 8. Cost change. Only call it out if material (≥ £0.5m). The model
  //    already accounted for budget, but the user wants to see the trade.
  if (Math.abs(input.netCost) >= 5) {
    if (input.netCost <= 0) {
      out.push({
        tone: 'positive',
        headline: 'Frees budget',
        detail: `Frees £${(Math.abs(input.netCost) / 10).toFixed(1)}m for upgrades elsewhere — and ${input.inName} is still rated higher.`
      });
    } else {
      out.push({
        tone: 'neutral',
        headline: 'Costs more',
        detail: `Net spend £${(input.netCost / 10).toFixed(1)}m. EV gap (+${input.evGain1.toFixed(2)}/GW) justifies the spend.`
      });
    }
  }

  // 9. Bench warning. Defensive — should be filtered out upstream, but if
  //    one slips through (e.g. wildcard mode), flag it loudly.
  if (!input.startsImmediately) {
    out.push({
      tone: 'negative',
      headline: 'Bench upgrade only',
      detail: `${input.inName} wouldn't crack your auto-picked XI right now — bench depth, not XI upgrade.`
    });
  }

  // Order: positives first (lead with the strongest argument), then neutrals,
  // then negatives (so trade-offs land last). Cap at 6.
  const positives = out.filter(r => r.tone === 'positive');
  const neutrals  = out.filter(r => r.tone === 'neutral');
  const negatives = out.filter(r => r.tone === 'negative');
  return [...positives, ...neutrals, ...negatives].slice(0, 6);
}
