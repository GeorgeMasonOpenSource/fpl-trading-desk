// Season-stage weights. All of this is deterministic and inspectable.
// The actual numbers are starting priors. Backtesting (lib/backtest) is what
// tells us whether to keep, raise, or drop each weight.

export type Stage = 'early' | 'mid' | 'late';

export function classifyStage(gw: number): Stage {
  if (gw <= 6) return 'early';
  if (gw <= 32) return 'mid';
  return 'late';
}

export interface StageWeights {
  // How much we trust this season's data vs long-term baseline.
  currentSeasonWeight: number;     // 0..1
  baselineWeight: number;          // 0..1
  // Penalty applied to expected-points confidence for unproven new signings.
  newSigningUncertainty: number;   // 0..1
  // Penalty applied to depth-chart confidence after manager changes / tactical shifts.
  managerChangeUncertainty: number;
  // Late-season team-objective weight. Off by default — backtesting promotes it.
  teamObjectiveWeight: number;     // 0..0.2
  // Fixture/opponent weight (lifts late season as fixtures matter more vs hot-streaks).
  fixtureWeight: number;
}

export function weightsForStage(stage: Stage): StageWeights {
  switch (stage) {
    case 'early':
      return {
        currentSeasonWeight: 0.25,
        baselineWeight:      0.75,
        newSigningUncertainty:   0.30,
        managerChangeUncertainty: 0.25,
        teamObjectiveWeight: 0.0,
        fixtureWeight:       0.8
      };
    case 'mid':
      return {
        currentSeasonWeight: 0.60,
        baselineWeight:      0.40,
        newSigningUncertainty:   0.10,
        managerChangeUncertainty: 0.10,
        teamObjectiveWeight: 0.0,
        fixtureWeight:       1.0
      };
    case 'late':
      return {
        currentSeasonWeight: 0.75,
        baselineWeight:      0.25,
        newSigningUncertainty:   0.05,
        managerChangeUncertainty: 0.05,
        teamObjectiveWeight: 0.05,   // small unless backtests prove higher is better
        fixtureWeight:       1.15
      };
  }
}
