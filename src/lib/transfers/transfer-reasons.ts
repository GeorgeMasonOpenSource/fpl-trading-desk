import type { PlayerInsight, EvComponents, PerGwDelta } from './insights';
import type { MinutesContextRow } from './minutes-context';
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
  /** Minutes-engine forecast for the OUT/IN players this GW. Drives rotation-risk bullets. */
  outMinutes?: MinutesContextRow;
  inMinutes?: MinutesContextRow;
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

  // 2b. ROTATION RISK — surface what the minutes engine actually forecasts
  //     this GW. The single biggest driver of weird recommendations is the
  //     model under/over-estimating someone's minutes. We surface both sides
  //     explicitly with the EV swing if the forecast is wrong, so the user
  //     can override with confidence rather than trust a hidden number.
  const POINTS_PER_GAME_AT_FULL_MINUTES = 4.0;  // rough mean for a starter
  if (input.inMinutes && input.inMinutes.expectedMinutes < 70) {
    const em = input.inMinutes.expectedMinutes;
    const sp = (input.inMinutes.startProb * 100).toFixed(0);
    // EV swing: if he actually plays 85 mins not `em`, the appearance + scaled
    // attacking points go up by (85 - em) / em × current_xpts. We use a
    // conservative 0.6 × xpts as the "scaled with minutes" portion.
    const swing = Math.max(0.3, ((85 - em) / Math.max(em, 40)) * 0.6 * 2.5).toFixed(1);
    out.push({
      tone: 'negative',
      headline: 'Rotation risk on IN',
      detail: `Model has ${input.inName} at only ${em.toFixed(0)} mins (start prob ${sp}%). If he plays 85+ instead, this swap gains ~${swing} more EV; if he plays <45, it loses ~${swing} EV. Check team news before pulling the trigger.`
    });
  }
  if (input.outMinutes && input.outMinutes.expectedMinutes < 70) {
    const em = input.outMinutes.expectedMinutes;
    const sp = (input.outMinutes.startProb * 100).toFixed(0);
    out.push({
      tone: 'positive',
      headline: 'Out is rotation risk',
      detail: `Model forecasts only ${em.toFixed(0)} mins for ${input.outName} (${sp}% start). That's the biggest argument for the swap — but if he actually starts and plays 80+, the EV gap collapses.`
    });
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

  // 3a. Shot quality — xG per open-play shot. A player with 6 shots/90 at
  //     0.10 xG/shot (long-range pots) is far less reliable than one with
  //     3 shots/90 at 0.22 xG/shot (box chances). Captures shot LOCATION
  //     quality, which raw xG totals hide.
  if (i?.shots && o?.shots && i.season.minutes > 0 && o.season.minutes > 0) {
    const inOpsP90    = (i.shots.openPlayShots * 90) / i.season.minutes;
    const outOpsP90   = (o.shots.openPlayShots * 90) / o.season.minutes;
    const inQuality   = i.shots.xgPerOpenPlayShot;
    const outQuality  = o.shots.xgPerOpenPlayShot;
    if (inOpsP90 - outOpsP90 >= 0.7 && inQuality >= 0.10) {
      out.push({
        tone: 'positive',
        headline: 'More box shots',
        detail: `${inOpsP90.toFixed(1)} open-play shots/90 (avg ${inQuality.toFixed(2)} xG/shot — ${qualityLabel(inQuality)}). ${input.outName}: ${outOpsP90.toFixed(1)}/90 at ${outQuality.toFixed(2)}.`
      });
    } else if (inQuality - outQuality >= 0.04 && i.shots.openPlayShots >= 15) {
      out.push({
        tone: 'positive',
        headline: 'Higher shot quality',
        detail: `${inQuality.toFixed(2)} xG/shot vs ${outQuality.toFixed(2)} for ${input.outName}. ${input.inName} gets cleaner chances — ${qualityLabel(inQuality)} territory.`
      });
    }
  }

  // 3b. Finishing — npGoals vs npxG. Negative delta means under-performing
  //     finishing (regression UP coming); positive means over-finishing
  //     (regression DOWN risk). Either is worth surfacing.
  if (i?.shots && i.shots.openPlayShots >= 15) {
    const d = i.shots.npFinishingDelta;
    if (d <= -2.0) {
      out.push({
        tone: 'positive',
        headline: 'Due to regress UP',
        detail: `${input.inName} has ${i.shots.npGoals} non-pen goals on ${i.shots.npxg.toFixed(1)} npxG — ${Math.abs(d).toFixed(1)} below expectation. Finishing should normalise — model treats him as undervalued.`
      });
    } else if (d >= 3.0) {
      out.push({
        tone: 'neutral',
        headline: 'Over-finishing risk',
        detail: `${i.shots.npGoals} non-pen goals on only ${i.shots.npxg.toFixed(1)} npxG — +${d.toFixed(1)} over expected. Elite finisher OR positive variance. Player-prior is shrinking this in the projection.`
      });
    }
  }

  // 3c. Player-prior boost — surface the Bayesian goal/bonus multipliers
  //     when they're materially above 1.0. Tells the user "this is an
  //     elite over the season, not just a hot streak".
  if (i?.priors) {
    const gm = i.priors.goalMult;
    const bm = i.priors.bonusMult;
    if (gm >= 1.15 && i.priors.sample90s >= 15) {
      out.push({
        tone: 'positive',
        headline: 'Elite finisher (prior)',
        detail: `Season prior: ${gm.toFixed(2)}× goal conversion vs his position median (over ${i.priors.sample90s.toFixed(0)} 90s). Model adds ~${((gm - 1) * 100).toFixed(0)}% to his raw goal xPts.`
      });
    }
    if (bm >= 1.15 && i.priors.sample90s >= 15) {
      out.push({
        tone: 'positive',
        headline: 'Bonus magnet',
        detail: `Earns ${bm.toFixed(2)}× the bonus his BPS-from-xG would suggest. Key passes, dribbles, fouls drawn — stuff that doesn't show in xG but adds bonus.`
      });
    }
  }

  // 3d. DEFCON proximity — for the +2 defcon threshold, what matters is
  //     P(actions ≥ 12). Surface the per-90 rate so the user knows whether
  //     the swap is a defcon play.
  if (i && o && i.season.minutes >= 900) {
    const inDc  = i.season.defconPer90;
    const outDc = o.season.defconPer90;
    if (inDc - outDc >= 1.5 && inDc >= 9) {
      out.push({
        tone: 'positive',
        headline: 'DEFCON threat',
        detail: `${inDc.toFixed(1)} defcon actions/90 (CBI+T+R) vs ${outDc.toFixed(1)} for ${input.outName}. Closer to the 12-action +2 pt threshold every match.`
      });
    }
  }

  // 3e. Opponent defence vs position — frames the upcoming fixture in
  //     position-specific terms, not generic FDR. A team can be top-5
  //     defensively overall but leaky vs MIDs (Spurs 24-25 was).
  if (i?.oppDefence && o?.oppDefence) {
    const inOd = i.oppDefence;
    const outOd = o.oppDefence;
    if (inOd.defenceMultiplier - outOd.defenceMultiplier >= 0.2 && inOd.matches >= 5) {
      out.push({
        tone: 'positive',
        headline: `Soft opp vs ${i.position}`,
        detail: `${inOd.oppShort} concedes ${inOd.xgConcededPerMatch.toFixed(2)} xG/match to ${i.position}s (${(inOd.defenceMultiplier * 100 - 100).toFixed(0)}% above league average). ${input.outName} faces ${outOd.oppShort} who's tighter.`
      });
    } else if (inOd.defenceMultiplier <= 0.85 && inOd.matches >= 5) {
      // Inbound has a hard opp — call it out so the user isn't surprised.
      out.push({
        tone: 'negative',
        headline: `Tough opp vs ${i.position}`,
        detail: `${inOd.oppShort} is ${((1 - inOd.defenceMultiplier) * 100).toFixed(0)}% tighter than average vs ${i.position}s — only ${inOd.xgConcededPerMatch.toFixed(2)} xG/match conceded. Form alone has to carry this swap.`
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
  // then negatives (so trade-offs land last). Cap at 8 — we now have richer
  // underlying-data bullets so a few more are worth showing.
  const positives = out.filter(r => r.tone === 'positive');
  const neutrals  = out.filter(r => r.tone === 'neutral');
  const negatives = out.filter(r => r.tone === 'negative');
  return [...positives, ...neutrals, ...negatives].slice(0, 8);
}

/**
 * Label an open-play xG-per-shot value so the user knows what they're
 * looking at. Anchors come from Understat's Premier League distribution
 * 2024-25: median open-play xG/shot ≈ 0.08, 75th pct ≈ 0.12, 90th ≈ 0.18.
 */
function qualityLabel(xgPerShot: number): string {
  if (xgPerShot >= 0.20) return 'elite — penalty-box specialist';
  if (xgPerShot >= 0.14) return 'high quality — central forward range';
  if (xgPerShot >= 0.10) return 'above average';
  if (xgPerShot >= 0.07) return 'league average';
  return 'low quality — mostly long-range';
}
