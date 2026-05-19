# FPL Trading Desk

A deterministic Fantasy Premier League quant terminal. Every transfer, captaincy
choice, chip move and roll decision is priced as a trade with expected value,
risk, opportunity cost and confidence. No machine learning, no LLMs, no
black-box AI — every rule is human-readable and inspectable.

## Stack

- **Next.js 14** (App Router) + TypeScript
- **Tailwind** for the dark trading-desk UI
- **PostgreSQL** (Neon Free / Neon Launch) as the single source of truth
- **GitHub Actions** for scheduled ingestion + recompute
- **Vercel Hobby** for hosting

Designed to run for **£15-£20 / month max**. No AWS / GCP / Azure / Kubernetes /
always-on workers / paid AI APIs / paid betting feeds. All optimisation is
precomputed; expensive paths run only on a manual trigger.

## Repo layout

```
fpl-trading-desk/
├── db/migrations/0001_initial.sql          # full schema (33+ tables)
├── scripts/                                # migrate.ts, seed.ts
├── src/
│   ├── app/
│   │   ├── layout.tsx + globals.css        # dark sidebar shell
│   │   ├── page.tsx                        # Dashboard
│   │   ├── my-team / transfer-planner / captaincy / chip-planner /
│   │   ├── mini-league / player-explorer / minutes-lab / role-matrix /
│   │   ├── rotation-radar / fixture-congestion / model-lab /
│   │   ├── backtesting / settings / manual-overrides
│   │   └── api/
│   │       ├── ingest/{bootstrap,fixtures,live,manager,league}
│   │       ├── projections, minutes, transfers, captaincy, chips, mini-league
│   │       ├── overrides, backtest, refresh
│   ├── components/                         # PlayerCard, RecommendationCard, ...
│   └── lib/
│       ├── db/                             # client.ts, queries.ts, types.ts
│       ├── fpl/                            # client.ts (raw cache + fetch), normalise.ts
│       ├── minutes/                        # reliability.ts, engine.ts
│       ├── projections/                    # baseline.ts, team-strength.ts, engine.ts
│       ├── transfers/                      # optimiser.ts
│       ├── captaincy/, chips/, mini-league/, role-matrix/, backtest/
│       └── util/                           # math.ts, season-stage.ts, auth.ts, colours.ts
└── .github/workflows/                      # ingest-daily, ingest-hourly, ingest-live
```

## UI-driven workflow

Everything you'd want to do is reachable from the top connection bar +
sidebar — no env-var fiddling required after the database is set up.

- **Connection bar** at the top of every page: shows manager / league / last
  ingest time, with inline edit, **Refresh now**, and **Disconnect**.
- **Dashboard** (`/`) is the single source of truth — when not connected it
  shows the Setup card; once connected it surfaces the recommended action,
  safe + aggressive captain picks, and your whole squad with the full minutes
  distribution + xPts breakdown.
- **Transfer Planner** (`/transfer-planner`) compares do_nothing / roll / ft1 /
  ft2 / -4 / -8 / wildcard scenarios, and at the bottom you get the
  **What-If transfer** playground — pick one player out + one player in and
  see the EV delta over 1/3/6/8 GW horizons with any constraint violations
  (budget, 3-per-club, position). No FPL submission ever happens.
- **Manual Overrides** (`/manual-overrides`) has an inline form with presets
  for the common kinds (availability, minutes_cap, penalty_taker, set_piece,
  role, rotation). Disabling an override is a single click.
- **Settings** (`/settings`) shows what's set in your cookie vs env vars and
  lets you re-run the connect flow inline.

## What's in v1

Per the brief, v1 covers the full first deliverable:

- Full repo structure
- Full Postgres schema (every table from the spec — raw_fpl_responses through
  backtest_results and manual_overrides)
- FPL ingestion (`bootstrap-static`, `fixtures`, `event/{gw}/live`,
  `entry/{id}/`, `entry/{id}/history/`, `entry/{id}/event/{gw}/picks/`,
  `leagues-classic/{id}/standings/`)
- **Minutes Engine** — first-class model producing a full distribution
  (start / 60+ / 90 / sub / bench-unused / injury-absence / early-sub-risk) per
  player per fixture, plus Minutes Reliability Index and Rotation Resistance
  Coefficient derived from data (never hard-coded)
- **Projection Engine** — deterministic xPts with broken-out components
  (appearance, goals, assists, CS, bonus, saves, pen-save, cards, concede, OG),
  floor / ceiling, risk, confidence, plus a reason audit trail
- Long-term player baselines (geometric decay across past seasons) shrunk
  against the current sample — does NOT chase last week's goals
- Team-strength model + per-fixture xG-for / xG-against / CS probability
- **Transfer Optimiser** — do-nothing, roll, ft1, ft2, -4 hit, -8 hit, wildcard
  scenarios over 1/3/6/8 GW horizons, FPL constraints respected (budget,
  3-per-club, position symmetry)
- **Captaincy Engine** — safe / aggressive / mini-league / triple-captain buckets
  with effective ownership across your league
- **Chip Simulator** — WC / FH / BB / TC EV per future GW, opportunity cost
- **Mini League War Room** — threats, helpers, captain differences, point-swing
  events, safe vs aggressive plays
- **Role Matrix** — roles inferred from current-season lineup + minutes
  observations with confidence decay, multiple roles per player, manual
  override support
- **Backtesting** — replay any GW window with rule toggles; metrics include MAE,
  RMSE, Spearman rank correlation, captain top-3 hit rate, minutes calibration
- Manual override system (structured facts only — `availability`, `minutes_cap`,
  `penalty_taker`, `set_piece`, `role`, etc.)
- Stale data warnings
- Dark trading-desk UI with generic club-inspired colour blocks (no logos,
  badges, kits, sponsors, photos)
- 15 pages, the full list from the brief, including Dashboard, Transfer Planner,
  Captaincy, Chip Planner, Mini League War Room, Player Explorer, Minutes Lab,
  Role Matrix, Rotation Radar, Fixture Congestion, Model Lab, Backtesting,
  Settings, Manual Overrides
- GitHub Actions for daily / hourly / 5-minute live ingestion

## Setup

### 1. Prerequisites

- Node 18.18+ (Node 22 LTS recommended)
- A Neon Free or Neon Launch project (or any Postgres database)
- A Vercel account (Hobby tier)
- A GitHub repo for scheduled jobs

### 2. Install + configure

```bash
git clone <your-repo>
cd fpl-trading-desk
cp .env.example .env
npm install
```

Set the following in `.env`:

```bash
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DB?sslmode=require
DIRECT_DATABASE_URL=postgresql://USER:PASSWORD@HOST/DB?sslmode=require
FPL_MANAGER_ID=1234567        # your FPL team ID
FPL_LEAGUE_ID=987654          # a classic league you're in (optional but recommended)
INGEST_SECRET=<random-long-string>
EV_TRANSFER_THRESHOLD=0.6
EV_HIT_THRESHOLD=1.5
```

Use Neon's pooled URL for `DATABASE_URL` and the direct URL for
`DIRECT_DATABASE_URL` (the migration runner uses the direct URL).

### 3. Migrate

```bash
npm run db:migrate    # applies db/migrations/*.sql idempotently
```

### 4. Run locally + connect

```bash
npm run dev           # http://localhost:3000
```

Open the app. Because no manager is connected yet, the Dashboard shows a
**Connect your FPL team** card:

1. Enter your **FPL Manager ID** (and optionally a **Classic League ID**).
2. Click **Connect & ingest** — the server validates the ID against FPL, pulls
   bootstrap + fixtures + your manager picks + league standings, and runs the
   model. Takes 5-15s the first time.
3. The dashboard repopulates with your squad, transfer routes, captain ranking,
   chip timeline, and (if you provided a league) mini-league intel.

The ID is stored in a cookie so it survives refreshes. At any time you can:

- **edit** — change the manager/league IDs from the bar at the top.
- **Refresh now** — re-ingest + recompute (same as the daily cron, on demand).
- **Disconnect** — clear the cookie and start over.

The `db:seed` script is no longer required for first-run — you can still use it
for non-interactive CI / smoke testing:

```bash
FPL_MANAGER_ID=1234567 npm run db:seed
```

### 5. Deploy to Vercel

1. Push the repo to GitHub.
2. Import it in Vercel (defaults work — Next.js auto-detected).
3. Set environment variables in the Vercel project: `DATABASE_URL`,
   `FPL_MANAGER_ID`, `FPL_LEAGUE_ID`, `INGEST_SECRET`,
   `EV_TRANSFER_THRESHOLD`, `EV_HIT_THRESHOLD`.
4. Deploy. Note the deployment URL (e.g. `https://fpl-td.vercel.app`).

### 6. Scheduled GitHub Actions

In the GitHub repo settings, add **Repository secrets**:

| Secret              | Value                                              |
| ------------------- | -------------------------------------------------- |
| `BASE_URL`          | Your Vercel deployment URL                         |
| `INGEST_SECRET`     | Same value as in `.env`                            |
| `FPL_MANAGER_ID`    | Your manager ID                                    |
| `FPL_LEAGUE_ID`     | Your league ID                                     |

Workflows already on disk:

- `.github/workflows/ingest-daily.yml` — 05:15 UTC every day:
  bootstrap → fixtures → refresh model → manager picks → league snapshot
- `.github/workflows/ingest-hourly.yml` — every hour: light fixture refresh +
  manager picks
- `.github/workflows/ingest-live.yml` — every 5 minutes: pulls live event data
  during matches (returns fast outside live windows so cost is bounded)

You can also POST to `/api/refresh` with `Authorization: Bearer <INGEST_SECRET>`
to manually re-run team strengths → baselines → minutes → projections.

## How to think about the engines

### Minutes are a first-class model

`projection xPts` is downstream of the minutes distribution. A 0.80 chance of
90 + 0.20 chance of 0 is treated very differently from a 1.00 chance of 72. The
projection engine consumes the full distribution (start_prob, sixty_plus_prob,
ninety_prob, sub_prob, bench_unused_prob, injury_absence_prob, early_sub_risk).

### Reliability is data-derived

`Minutes Reliability Index` and `Rotation Resistance Coefficient` are computed
from `player_gameweek_history` — appearance rate, 90-min rate, early-sub
penalty, and the player's start rate during fixture-congestion windows
(≤4 days rest or post-Europe). No player is hard-coded as "nailed".

### We do not chase recent goals

Current-season per-90 xG/xA are shrunk toward each player's geometrically
decayed prior using equivalent-sample-size logic. A 2-game hot streak doesn't
override a season of priors.

### Roll is always on the menu

If no transfer move clears `EV_TRANSFER_THRESHOLD`, the recommended action
becomes `roll`. The transfer scenario list always includes `do_nothing` and
`roll` alongside `ft1`, `ft2`, `hit_-4`, `hit_-8`, and an indicative `wildcard`.

### Every assumption is inspectable

`projection_snapshots` is append-only — every projection that has ever been
shown to the user is preserved with its full payload. `recommendation_history`
captures every action surfaced (transfer, captain, chip, roll, no-op) along
with the EV, risk, and confidence at the time. Backtesting replays these
deterministically.

## Known v1 limitations

- **Wildcard optimiser is greedy, not optimal.** It picks the bottom-5 weakest
  slots and upgrades them within budget. A v2 LP / beam search is planned.
- **Effective ownership is from the user's mini league only**, not the global
  top-10k. Global EO needs ingesting a wider league sample (cheap to add).
- **European fixtures are manual.** No free reliable feed exists; the
  `european_fixtures` table is populated by `POST /api/overrides` with
  `scope='team'` and `kind='european_fixture'` until a free source is added.
- **Player attacking share is partial.** Penalty / set-piece share is wired up
  from manual overrides; goal-share / assist-share inference from
  observed shot data is a v2 task.
- **Backtesting is read-only.** It can re-score historical projections but does
  not yet re-derive minutes / projections under counterfactual rule toggles.
  The rule-toggle plumbing exists in `BacktestSpec` — implementation is v2.
- **Manager-change uncertainty** is wired through the engine but the
  detection-of-manager-change signal still needs an upstream source (manual
  override `kind='manager_change'` works today).
- **Team objective scoring** is intentionally near-zero until backtesting
  proves it improves accuracy. Don't promote it without data.
- **Bonus points** uses a simple per-90 baseline. A v2 BPS-based bonus model
  would be more accurate, especially for defenders.

## Roadmap to v2

1. **Full wildcard optimiser** — proper LP or beam search behind a manual
   button (heavy compute, run on demand, persist result).
2. **xG-share / shot-share model** — derive open-play goal threat and assist
   threat from observed shot maps once a free, legal data source is wired in.
3. **Global EO** — ingest the top-1k overall + top-100 of the user's league
   each GW for accurate template-vs-differential pricing.
4. **European fixture ingestion** — auto-pull UCL / UEL / UECL schedules from
   a free legal source.
5. **Counterfactual backtests** — the `BacktestSpec.rules` flags should toggle
   model code paths, not just metrics.
6. **Post-gameweek audit pages** — diff `recommendation_history` against
   actuals, attribute "good decision unlucky" vs "model error".
7. **Market-odds calibration layer** — optional, off by default, only if a
   legal free or cheap feed exists; never the source of truth.
8. **More UI** — `RoleMatrixPitch` SVG, `FixtureCongestionHeatmap`,
   `PlayerComparisonDrawer` (placeholders exist in the components folder for
   v2 work; data is already there).
9. **Multi-manager support** — v1 is single-user; v2 wires Clerk/Auth.js +
   per-user secrets.

## Local recipes

```bash
# Re-run migrations
npm run db:migrate

# Bootstrap from scratch (idempotent)
npm run db:seed

# Recompute projections for the next GW
curl -X POST http://localhost:3000/api/refresh \
  -H "authorization: Bearer $INGEST_SECRET"

# Inspect cached projections
curl "http://localhost:3000/api/projections?gameweek=12"

# Score transfer scenarios for your manager
curl "http://localhost:3000/api/transfers?gameweek=12"

# Run a backtest
curl -X POST http://localhost:3000/api/backtest \
  -H "content-type: application/json" \
  -d '{"name":"v1_baseline","fromGameweek":1,"toGameweek":10}'

# Add a manual override (e.g. confirm a penalty taker)
curl -X POST http://localhost:3000/api/overrides \
  -H "content-type: application/json" \
  -d '{"scope":"player","scopeId":351,"kind":"penalty_taker","value":{"share":0.95}}'
```

## Design principles (non-negotiable)

- Do not recommend action unless expected edge clears a threshold.
- Always compare against doing nothing.
- Separate expected value from risk.
- Separate projection from confidence.
- Surface stale assumptions.
- Make every assumption inspectable.
- Deterministic and reproducible.
- Current-season-sensitive for roles and minutes.
- Historical data is for reliability / durability / rotation-resistance only.
- Reduce confidence when a player changes club, manager, position or role.
- Allow manual factual overrides — never human-opinion-based recommendations.
- No ML / LLM / black-box AI in the decision path.

---

Built to be independent, transparent, and useful before deadline.
