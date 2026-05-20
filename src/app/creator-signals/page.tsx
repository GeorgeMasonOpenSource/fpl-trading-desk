import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { sql } from '@/lib/db/client';
import { getManagerId } from '@/lib/session';
import { NotConnected } from '@/components/NotConnected';
import { acceptSignal, dismissSignal } from '@/app/actions/creator-signals';
import { getSignalValidations, alignVerdictToKind, type Verdict } from '@/lib/signals/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Row {
  signal_id: number;
  player_id: number;
  web_name: string;
  position: string;
  team_short: string;
  signal_kind: string;
  confidence: number;
  raw_quote: string;
  timestamp_sec: number;
  video_section: string | null;
  user_action: string | null;
  video_id: string;
  video_url: string;
  channel_name: string;
  video_title: string;
  published_at: string;
  owned: boolean;
}

interface ConsensusRow {
  player_id: number;
  signal_kind: string;
  distinct_creators: number;
  total_mentions: number;
  creator_names: string[];
}

export default async function CreatorSignals() {
  const managerId = getManagerId();
  if (!managerId) return <NotConnected where="Creator Signals" />;

  const rows = await sql<Row[]>`
    SELECT s.id AS signal_id, s.player_id, p.web_name, p.position, t.short_name AS team_short,
           s.signal_kind, s.confidence, s.raw_quote, s.timestamp_sec,
           s.video_section, s.user_action,
           v.video_id, v.url AS video_url, v.channel_name, v.title AS video_title,
           v.published_at,
           EXISTS (
             SELECT 1 FROM manager_picks mp
             WHERE mp.manager_id = ${managerId}
               AND mp.player_id = s.player_id
               AND mp.gameweek_id IN (
                 SELECT id FROM gameweeks WHERE is_current OR is_next
               )
           ) AS owned
      FROM transcript_signals s
      JOIN players p   ON p.id = s.player_id
      JOIN teams t     ON t.id = p.team_id
      JOIN youtube_videos v ON v.video_id = s.video_id
     WHERE s.user_action IS NULL
       AND v.published_at > now() - INTERVAL '14 days'
     ORDER BY owned DESC, s.confidence DESC, v.published_at DESC
     LIMIT 200
  `;

  // §2a: validation badges. Pull the planning gameweek so the validation
  // horizon (3 GW) lines up with the planner's top-10 horizon. Falls back to
  // the current GW if there's no upcoming deadline (off-season).
  const gwRows = await sql<Array<{ id: number }>>`
    SELECT id FROM gameweeks
     WHERE deadline_time > now()
     ORDER BY deadline_time ASC
     LIMIT 1
  `;
  let startGw = gwRows[0]?.id;
  if (!startGw) {
    const cur = await sql<Array<{ id: number }>>`
      SELECT id FROM gameweeks WHERE is_current = TRUE LIMIT 1
    `;
    startGw = cur[0]?.id;
  }
  const distinctPlayerIds = Array.from(new Set(rows.map(r => r.player_id)));
  const validations = startGw
    ? await getSignalValidations(distinctPlayerIds, startGw)
    : new Map();

  // §1c: pull consensus rollups for every player on screen so we can promote
  // multi-creator endorsements to the top of the board.
  const consensusRows = distinctPlayerIds.length === 0 ? [] : await sql<ConsensusRow[]>`
    SELECT player_id, signal_kind, distinct_creators, total_mentions, creator_names
      FROM creator_consensus
     WHERE player_id IN ${sql(distinctPlayerIds as any)}
  `;
  const consensusByPlayer = new Map<number, ConsensusRow[]>();
  for (const c of consensusRows) {
    if (!consensusByPlayer.has(c.player_id)) consensusByPlayer.set(c.player_id, []);
    consensusByPlayer.get(c.player_id)!.push(c);
  }

  // Group rows by player so the UI can show one card per player with all the
  // creators' takes underneath. Sort: owned squad members first, then by
  // maximum consensus level across that player's signals (so a 3/3 endorsed
  // player jumps to the top), then by total mentions for the tiebreak.
  const byPlayer = new Map<number, Row[]>();
  for (const r of rows) {
    if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, []);
    byPlayer.get(r.player_id)!.push(r);
  }
  const maxConsensusFor = (pid: number): number => {
    const list = consensusByPlayer.get(pid) ?? [];
    return list.reduce((m, c) => Math.max(m, c.distinct_creators), 0);
  };
  const groups = Array.from(byPlayer.values()).sort((a, b) => {
    const ao = a[0]!.owned ? 1 : 0;
    const bo = b[0]!.owned ? 1 : 0;
    if (ao !== bo) return bo - ao;
    const ac = maxConsensusFor(a[0]!.player_id);
    const bc = maxConsensusFor(b[0]!.player_id);
    if (ac !== bc) return bc - ac;
    return b.length - a.length;
  });

  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Creator board</div>
        <h1 className="text-2xl font-semibold">Pending signals from FPL channels</h1>
        <p className="text-sm text-ink-muted mt-1 max-w-2xl">
          Deterministically extracted from YouTube captions — every signal links back
          to the exact moment in the video. Accept to translate into a manual override
          (the only path by which creator commentary influences the model). Dismiss to
          hide. Editorial signals (recommend / watching / buying / selling) don't auto-translate;
          they're for your judgement.
        </p>
      </header>

      {groups.length === 0 ? (
        <Card title="No pending signals">
          <p className="text-sm text-ink-muted">
            Either nothing new has been ingested in the last 14 days, or every signal has
            been reviewed. Run <span className="font-mono">npm run ingest:youtube</span>{' '}
            locally to pull the latest videos.
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {groups.map(group => {
            const pid = group[0]!.player_id;
            return (
              <PlayerCard
                key={pid}
                rows={group}
                validation={validations.get(pid)}
                consensus={consensusByPlayer.get(pid) ?? []}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function PlayerCard({
  rows, validation, consensus
}: {
  rows: Row[];
  validation?: import('@/lib/signals/validation').Validation;
  consensus: ConsensusRow[];
}) {
  const head = rows[0]!;
  // Roll up: how many creators recommend / buy / sell etc.
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.signal_kind] = (counts[r.signal_kind] ?? 0) + 1;
  // Max consensus across signal kinds for this player, used for the top-line
  // "endorsed by 3 creators" pill.
  const maxConsensus = consensus.reduce((m, c) => Math.max(m, c.distinct_creators), 0);
  return (
    <div className="bg-bg-card border border-line rounded-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-semibold text-lg">
            {head.web_name}
            <span className="text-xs text-ink-dim font-mono ml-2">
              {head.position} · {head.team_short}
            </span>
          </div>
          {validation && (
            <div className="text-[10px] text-ink-dim mt-0.5" title={validation.detail}>
              model: <span className="font-mono">{validation.modelXpts.toFixed(1)} xPts</span>
              {' '}over next 3 GW
              {validation.positionCount > 0 && (
                <> · #{validation.positionRank}/{validation.positionCount} {head.position}</>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          {head.owned && <Badge tone="blue">in squad</Badge>}
          {maxConsensus >= 2 && (
            <Badge tone={maxConsensus >= 3 ? 'green' : 'violet'} title={
              consensus.map(c => `${c.signal_kind}: ${c.creator_names.join(', ')}`).join(' | ')
            }>
              {maxConsensus}× consensus
            </Badge>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 text-[10px]">
        {Object.entries(counts).map(([k, n]) => (
          <Badge key={k} tone={kindTone(k)}>{k} ×{n}</Badge>
        ))}
      </div>

      <ul className="divide-y divide-line">
        {rows.map(r => {
          // Align the verdict to the signal kind — model AGREES with a `selling`
          // call when the player is bottom-quartile, not top-quartile.
          const alignedVerdict: Verdict = validation
            ? alignVerdictToKind(validation.verdict, r.signal_kind)
            : 'no_data';
          return (
          <li key={r.signal_id} className="py-2 space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <div className="flex items-center gap-2 text-ink-muted flex-wrap">
                <Badge tone={kindTone(r.signal_kind)}>{r.signal_kind}</Badge>
                <VerdictBadge verdict={alignedVerdict} detail={validation?.detail} />
                {r.video_section && (
                  <Badge tone="steel" title="Detected video section">
                    {r.video_section.replace(/_/g, ' ')}
                  </Badge>
                )}
                <span className="font-mono">conf {Math.round(r.confidence * 100)}%</span>
                <span>·</span>
                <a
                  href={`${r.video_url}&t=${r.timestamp_sec}s`}
                  target="_blank" rel="noopener noreferrer"
                  className="text-accent-blue hover:underline"
                >
                  {r.channel_name} @ {formatTime(r.timestamp_sec)} ↗
                </a>
              </div>
              <span className="text-[10px] text-ink-dim font-mono">
                {new Date(r.published_at).toISOString().slice(0, 10)}
              </span>
            </div>
            <blockquote className="text-xs italic text-ink-muted border-l-2 border-line pl-2">
              "{r.raw_quote}"
            </blockquote>
            <div className="flex gap-2">
              <form action={acceptSignal}>
                <input type="hidden" name="id" value={r.signal_id} />
                <input type="hidden" name="model_verdict" value={alignedVerdict} />
                <button className="bg-accent-green/90 hover:bg-accent-green text-bg px-2 py-0.5 text-[10px] font-medium rounded">
                  Accept
                </button>
              </form>
              <form action={dismissSignal}>
                <input type="hidden" name="id" value={r.signal_id} />
                <button className="bg-bg-inset hover:bg-bg-raised text-ink-muted px-2 py-0.5 text-[10px] rounded">
                  Dismiss
                </button>
              </form>
            </div>
          </li>
          );
        })}
      </ul>
    </div>
  );
}

function VerdictBadge({ verdict, detail }: { verdict: Verdict; detail?: string }) {
  if (verdict === 'agrees')    return <Badge tone="green"  title={detail}>model agrees</Badge>;
  if (verdict === 'disagrees') return <Badge tone="red"    title={detail}>model disagrees</Badge>;
  if (verdict === 'neutral')   return <Badge tone="steel"  title={detail}>model neutral</Badge>;
  return <Badge tone="amber" title={detail ?? 'No data'}>no data</Badge>;
}

function kindTone(kind: string): 'green' | 'red' | 'amber' | 'blue' | 'violet' | 'steel' {
  switch (kind) {
    case 'recommend':
    case 'buying':
    case 'start':
    case 'penalty':
    case 'setpiece':
      return 'green';
    case 'selling':
    case 'bench':
    case 'injury':
      return 'red';
    case 'watching':
      return 'amber';
    default:
      return 'steel';
  }
}

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
