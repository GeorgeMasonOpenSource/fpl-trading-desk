/**
 * Transcript → structured signals extractor (deterministic).
 *
 * Walks a transcript chunk-by-chunk, identifies player references, then
 * runs a panel of regex patterns to classify each mention into one of:
 *
 *   factual   — start | bench | injury | penalty | setpiece
 *   editorial — recommend | watching | buying | selling
 *
 * Three add-ons (deterministic, no LLM):
 *
 *   §1a SECTION TAGGING. Most FPL streamers structure their videos —
 *       "captains", "transfers in", "transfers out", "differentials",
 *       "avoid". We detect those section headers and tag every signal
 *       extracted while a section is active. The section is consumed by
 *       the persistence layer + the Creator Board so a "love this player"
 *       said inside a transfers-out section is rendered (and treated) as a
 *       counterpoint, not a recommendation.
 *
 *   §1b NUMERIC CLAIM CAPTURE. Streamers throw out stats — "Bowen 35% of
 *       West Ham's chances", "Watkins 0.7 xG per 90". We pull them with a
 *       small regex panel so the model can validate them later.
 *
 *   §1d ORDERED RANKINGS. When a creator verbalises a list — "my top 3
 *       transfers in are 1) Anderson 2) Mbeumo 3) Saka" — we capture the
 *       ordered list so the §2b accuracy leaderboard has a clean source of
 *       truth ("creator X picked Anderson #1 in week 36").
 *
 * Every output carries the verbatim quote + timestamp so a human reviewer
 * can verify. No LLM, no fuzzy ML — just patterns and proximity matching
 * against the full FPL player list (loaded once from the DB).
 */
import type { TranscriptCue } from './transcript';

export type SignalKind =
  | 'start' | 'bench' | 'injury' | 'penalty' | 'setpiece'
  | 'recommend' | 'watching' | 'buying' | 'selling';

export type VideoSection =
  | 'captains' | 'transfers_in' | 'transfers_out'
  | 'differentials' | 'set_and_forget' | 'avoid';

export interface ExtractedSignal {
  playerId: number;
  webName: string;
  signalKind: SignalKind;
  confidence: number;          // 0..1
  rawQuote: string;            // ~120-char window around the matched mention
  startSec: number;            // seconds into the video
  // §1a: the active section header that was in scope when this mention was
  // found, if any. Null when the signal predates any section detection.
  videoSection: VideoSection | null;
}

/** §1b numeric claim — verbatim stat the creator cited. */
export interface NumericClaim {
  playerId: number;
  webName: string;
  metric: string;              // 'xg_per_90' | 'xa_per_90' | 'goal_involvement_pct' | 'returns_in_n' | 'shots' | 'minutes' | etc.
  metricValue: number;
  metricUnit: string | null;
  rawQuote: string;
  startSec: number;
}

/** §1d ordered ranking entry from a verbalised list. */
export interface CreatorRankingItem {
  rankingKind: 'transfers_in' | 'transfers_out' | 'captains' | 'differentials' | 'set_and_forget' | 'avoid';
  positionRank: number;        // 1, 2, 3, ...
  playerId: number;
  webName: string;
  rawQuote: string;
  startSec: number;
}

export interface ExtractionOutput {
  signals: ExtractedSignal[];
  numericClaims: NumericClaim[];
  rankings: CreatorRankingItem[];
}

export interface PlayerLexicon {
  playerId: number;
  webName: string;
  surname: string;             // last word of second_name, lowercased
  fullName: string;            // lowercased "first second"
  aliases: string[];           // optional extras like "KDB", "Sonny" — fed in externally
}

/* ---------------------------------------------------------------------------
 * Pattern panels — chosen for high precision on FPL-content phrasing.
 * Each regex looks at a small word-window AROUND the player name (we splice
 * the player name out before running the pattern).
 * -------------------------------------------------------------------------*/

interface Pattern {
  kind: SignalKind;
  re: RegExp;
  baseConfidence: number;
  /** If true, regex must match BEFORE the player name; otherwise either side. */
  beforeOnly?: boolean;
  /** If true, must match AFTER. */
  afterOnly?: boolean;
}

/* ---------------------------------------------------------------------------
 * §1a Section-header patterns
 * Detect the "moving on to my transfers in" / "let's talk captains" cues that
 * mark the start of a new section. Each pattern maps to a VideoSection — once
 * a header is seen, every subsequent signal until the next header is tagged
 * with that section.
 * -------------------------------------------------------------------------*/
const SECTION_HEADERS: Array<{ re: RegExp; section: VideoSection }> = [
  // Captains
  { re: /\b(captain(?:cy)?(?: pick(?:s)?| section| time| corner)?|who['']s your captain|let['']s talk captain|captain(?:cy)? choices?|c\(c\))\b/i, section: 'captains' },
  // Transfers IN (covers "moving on to", "transfer ins", "buys")
  { re: /\b(transfer(?:s)? in|players to buy|incoming(?:s)?|my (?:targets?|buys?|incomings?)|moving on to (?:my )?transfers? in|who (?:to|should you|are you) buy|buy(?:ing)? list)\b/i, section: 'transfers_in' },
  // Transfers OUT
  { re: /\b(transfer(?:s)? out|players to sell|sells?|outgoing(?:s)?|my (?:sells?|outgoings?)|who (?:to|should you|are you) sell|sell(?:ing)? list|players to (?:move on|ditch|get rid of)|moving on from)\b/i, section: 'transfers_out' },
  // Differentials
  { re: /\b(differential(?:s)? (?:pick(?:s)?|section|time|corner|of the week)?|low[- ]?owned (?:gems?|picks?)|under[- ]?the[- ]?radar|hidden gems?)\b/i, section: 'differentials' },
  // Set and forget
  { re: /\b(set and forget|set[- ]?and[- ]?forget|fire and forget|long[- ]?term hold(?:s)?)\b/i, section: 'set_and_forget' },
  // Avoid
  { re: /\b(players to avoid|avoid list|stay away from|do not buy|dnp(?:'?s)? to fade|fade list|red flags?(?: this week)?)\b/i, section: 'avoid' }
];

/* ---------------------------------------------------------------------------
 * §1b Numeric claim patterns
 * Each tuple matches a NUMERIC near a player mention. We scan within the same
 * 80-char window the signal extractor uses, so the metric is attributed to
 * the closest mentioned player. Metric keys are stable so the validator in
 * src/lib/signals/validation.ts can compare creator value vs model value.
 * -------------------------------------------------------------------------*/
interface NumericPattern {
  metric: string;
  re: RegExp;                          // group 1 = numeric value; optional group 2 = unit
  unit?: string;                       // override unit string
}

const NUMERIC_PATTERNS: NumericPattern[] = [
  // "0.7 xG per 90" / "xG of 0.55" / "0.55 expected goals"
  { metric: 'xg_per_90',           re: /(\d+(?:\.\d+)?)\s*xg(?:\s*(?:per|\/)\s*90)?\b/i, unit: 'per_90' },
  { metric: 'xa_per_90',           re: /(\d+(?:\.\d+)?)\s*xa(?:\s*(?:per|\/)\s*90)?\b/i, unit: 'per_90' },
  { metric: 'xgi_per_90',          re: /(\d+(?:\.\d+)?)\s*xgi(?:\s*(?:per|\/)\s*90)?\b/i, unit: 'per_90' },
  // "35% of West Ham's chances" / "35 percent involvement"
  { metric: 'goal_involvement_pct', re: /(\d+(?:\.\d+)?)\s*%?\s*(?:of (?:the )?(?:team['']?s?|side['']?s?|club['']?s?)?\s*(?:chances|big chances|xG|threat|involvement|goal involvement))/i, unit: '%' },
  // "8 returns in 5 games" / "12 returns in his last 8"
  { metric: 'returns_in_n',         re: /(\d+)\s*returns?\s*(?:in|over|across)\s*(?:his |the )?(?:last\s*)?(\d+)\s*(?:games?|matches?|gameweeks?|gws?)/i, unit: 'count' },
  // "(0|1|2|...) goals" — only meaningful in a "last N games" context, so we
  // require a nearby "in last" qualifier. Captured as a separate metric.
  { metric: 'goals_in_n',           re: /(\d+)\s*goals?\s*(?:in|over)\s*(?:his |the )?(?:last\s*)?(\d+)\s*(?:games?|matches?|gameweeks?|gws?)/i, unit: 'count' },
  { metric: 'assists_in_n',         re: /(\d+)\s*assists?\s*(?:in|over)\s*(?:his |the )?(?:last\s*)?(\d+)\s*(?:games?|matches?|gameweeks?|gws?)/i, unit: 'count' },
  // Shots in the box: "3 shots in the box per game"
  { metric: 'shots_in_box_per_game', re: /(\d+(?:\.\d+)?)\s*shots? (?:in (?:the )?box|inside the box)\s*(?:per|\/)\s*(?:game|90)/i, unit: 'per_game' },
  // Minutes: "90 minutes" / "played 87 minutes"
  { metric: 'minutes_last',         re: /(\d{2,3})\s*minutes\b/i, unit: 'minutes' },
  // Ownership/price weren't in the playerly-stat category — skip.
];

/* ---------------------------------------------------------------------------
 * §1d Ranking detection
 * Two phrasings we recognise:
 *   (a) "my top 3 transfers in are 1) X 2) Y 3) Z" — explicit numbered list
 *   (b) "number one is X, number two is Y, number three is Z"
 * For each, we match the lead-in (which also tells us the ranking_kind) then
 * walk forward looking for a sequence of "N) NAME" or "number N is NAME" up
 * to a configurable max rank. Within a ranking window we skip the normal
 * signal panel for the player slots to avoid double-counting.
 * -------------------------------------------------------------------------*/
const RANKING_INTROS: Array<{
  re: RegExp;
  kind: CreatorRankingItem['rankingKind'];
}> = [
  { re: /\bmy\s+top\s+\d+\s+(?:transfers? in|incomings?|buys?)\b/i,            kind: 'transfers_in' },
  { re: /\bmy\s+top\s+\d+\s+(?:transfers? out|outgoings?|sells?)\b/i,           kind: 'transfers_out' },
  { re: /\bmy\s+top\s+\d+\s+(?:captains?|captaincy picks?)\b/i,                 kind: 'captains' },
  { re: /\bmy\s+top\s+\d+\s+(?:differentials?)\b/i,                             kind: 'differentials' },
  { re: /\btop\s+\d+\s+(?:transfers? in|incomings?|buys?)\b/i,                  kind: 'transfers_in' },
  { re: /\btop\s+\d+\s+(?:transfers? out|outgoings?|sells?)\b/i,                kind: 'transfers_out' },
  { re: /\btop\s+\d+\s+(?:captains?|captaincy picks?)\b/i,                      kind: 'captains' }
];

const PATTERNS: Pattern[] = [
  // ----- Editorial: recommendations / watch / transfer leanings ----------
  { kind: 'recommend', re: /\b(must[\s-]?(?:own|have)|essential|premium pick|love|favourite|safe captain|stack)\b/i,    baseConfidence: 0.75 },
  { kind: 'recommend', re: /\b(top|best|great|brilliant|solid|excellent) (?:pick|option|choice|shout)\b/i,             baseConfidence: 0.70 },
  { kind: 'recommend', re: /\b(in form|nailed|on fire|flying|in red[- ]?hot form|banker)\b/i,                          baseConfidence: 0.65 },
  { kind: 'watching',  re: /\b(watch(?:ing|list)|keeping (?:an )?eye on|monitoring|on my radar|on the radar|one to watch)\b/i, baseConfidence: 0.70 },
  { kind: 'buying',    re: /\b(bringing in|transferring in|buying|getting in|going to (?:buy|bring in)|signing|moving to|leaning towards|leaning to)\b/i, baseConfidence: 0.75 },
  { kind: 'buying',    re: /\b(my transfer (?:this week|in)|my (?:in|incoming))\b/i,                                   baseConfidence: 0.80 },
  { kind: 'selling',   re: /\b(selling|transferring out|moving on from|getting rid of|dropping|ditching|out of (?:my|the) team)\b/i, baseConfidence: 0.80 },
  { kind: 'selling',   re: /\b(my transfer out|my (?:out|outgoing))\b/i,                                               baseConfidence: 0.80 },

  // ----- Factual: lineup / injury / set-piece ---------------------------
  { kind: 'start',     re: /\b(starting|nailed|will start|expected to start|likely to start|in the (?:starting )?eleven|XI)\b/i, baseConfidence: 0.75 },
  { kind: 'bench',     re: /\b(benched|on the bench|dropped|rotated|won['']t start|rested|left out|cameo|impact sub)\b/i, baseConfidence: 0.75 },
  { kind: 'injury',    re: /\b(injured|injury|doubt(?:ful)?|knock|hamstring|groin|calf|knee|ankle|ruled out|fitness concern|miss(?:es|ed|ing)? (?:the )?(?:weekend|match|game)|out for)\b/i, baseConfidence: 0.80 },
  { kind: 'penalty',   re: /\b(on (?:the )?pens?|penalty taker|takes (?:the )?pens?|pens? (?:are )?his|first[- ]choice (?:pen|penalty))\b/i, baseConfidence: 0.80 },
  { kind: 'setpiece',  re: /\b(corners?|set[\s-]?pieces?|set[\s-]?play|free[\s-]?kicks?|deliveries)\b/i,               baseConfidence: 0.55 }
];

/* ---------------------------------------------------------------------------
 * Build a transcript paragraph from cues — sentences span multiple cues so
 * we need a flat text window with offsets back to cue.startSec.
 * -------------------------------------------------------------------------*/

interface FlatToken {
  text: string;
  startSec: number;
}

function flatten(cues: TranscriptCue[]): FlatToken[] {
  return cues.map(c => ({ text: c.text, startSec: c.startSec }));
}

/* ---------------------------------------------------------------------------
 * Main extractor
 * -------------------------------------------------------------------------*/

/**
 * Backwards-compatible wrapper: returns only the signal list. New callers
 * should use `extractAll` to also get numeric claims and ordered rankings.
 */
export function extractSignals(
  cues: TranscriptCue[],
  lexicon: PlayerLexicon[]
): ExtractedSignal[] {
  return extractAll(cues, lexicon).signals;
}

/**
 * Full extraction pass — signals + numeric claims + ordered rankings, all
 * tagged with the active video section.
 */
export function extractAll(
  cues: TranscriptCue[],
  lexicon: PlayerLexicon[]
): ExtractionOutput {
  const tokens = flatten(cues);
  if (tokens.length === 0 || lexicon.length === 0) {
    return { signals: [], numericClaims: [], rankings: [] };
  }

  // Build a fast surname → lexicon-entry map (lowercased) and a regex of all
  // surnames OR aliases so we can find candidate mentions in O(n) per cue.
  const surnameToEntries = new Map<string, PlayerLexicon[]>();
  const aliasToEntry     = new Map<string, PlayerLexicon>();
  for (const p of lexicon) {
    if (!surnameToEntries.has(p.surname)) surnameToEntries.set(p.surname, []);
    surnameToEntries.get(p.surname)!.push(p);
    for (const a of p.aliases) {
      aliasToEntry.set(a.toLowerCase(), p);
    }
  }
  const allNeedles = [
    ...new Set([
      ...surnameToEntries.keys(),
      ...aliasToEntry.keys()
    ])
  ]
    // Drop short needles (noisy) and our English-word stopword list. Real
    // players matching a stopword surname (e.g. "Son") stay reachable via
    // their explicit aliases.
    .filter(s => s.length >= 3 && !SURNAME_STOPWORDS.has(s))
    .sort((a, b) => b.length - a.length);

  // Compile one big alternation regex of all unique needles.
  const escaped = allNeedles.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const needleRe = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');

  const signals: ExtractedSignal[] = [];
  const numericClaims: NumericClaim[] = [];
  const rankings: CreatorRankingItem[] = [];

  // §1a active-section tracker. Each cue is scanned for a section header
  // before we extract signals from it; the most recent header wins until
  // overwritten. We log the cue index where the section changed so a
  // ranking window can also use it.
  let currentSection: VideoSection | null = null;

  // §1d ranking window — when we see a "top N transfers in" intro we
  // capture all numbered slots in the next 60 seconds of cues, then close.
  interface RankingWindow {
    kind: CreatorRankingItem['rankingKind'];
    startSec: number;
    endSec: number;
    nextRank: number;
    seenPlayers: Set<number>;
  }
  let rankingWindow: RankingWindow | null = null;

  // Stitch tokens into rolling 16-cue windows. Each cue is ~30-50 chars
  // so 16 cues gives ~500-800 chars of context to slice through. We need
  // this much because buildSentenceQuote now extends up to 2 sentences
  // forward (~280 chars on the right side of a mention).
  for (let i = 0; i < tokens.length; i++) {
    const window = tokens.slice(i, i + 16);
    const windowText = window.map(t => t.text).join(' ');
    const lower = windowText.toLowerCase();
    const windowStartSec = Math.round(window[0]!.startSec);

    // §1a — does this window open a new section? Scan only the first cue
    // (`tokens[i].text`) so we don't re-trigger from text we've already seen.
    const headCueText = tokens[i]!.text.toLowerCase();
    for (const h of SECTION_HEADERS) {
      if (h.re.test(headCueText)) {
        currentSection = h.section;
        break;
      }
    }

    // §1d — open a ranking window?
    for (const intro of RANKING_INTROS) {
      if (intro.re.test(headCueText)) {
        rankingWindow = {
          kind: intro.kind,
          startSec: windowStartSec,
          endSec: windowStartSec + 60,
          nextRank: 1,
          seenPlayers: new Set()
        };
        break;
      }
    }
    // Close the ranking window when we've moved past it.
    if (rankingWindow && windowStartSec > rankingWindow.endSec) {
      rankingWindow = null;
    }

    let match: RegExpExecArray | null;
    needleRe.lastIndex = 0;
    while ((match = needleRe.exec(lower)) !== null) {
      const needle = match[1]!.toLowerCase();
      const startIdx = match.index;
      const endIdx = startIdx + needle.length;

      // Resolve to player(s). Aliases are unambiguous; surnames may collide
      // (e.g. multiple Williams) — we'll emit one signal per collision and
      // let the human reviewer disambiguate.
      const entries = aliasToEntry.has(needle)
        ? [aliasToEntry.get(needle)!]
        : (surnameToEntries.get(needle) ?? []);
      if (entries.length === 0) continue;
      const ambiguous = entries.length > 1;
      const player = entries[0]!;

      // 80-char window around the mention for pattern matching.
      const before = lower.slice(Math.max(0, startIdx - 80), startIdx);
      const after  = lower.slice(endIdx, endIdx + 80);
      const around = before + ' ' + after;

      // §1d ranking slot detection — inside a ranking window, look for "1)"
      // or "number one" near the player mention. We accept either ordinal
      // ("number two") or numeric-with-bracket ("2)") within 30 chars.
      if (rankingWindow && !rankingWindow.seenPlayers.has(player.playerId)) {
        const slotMarker = matchRankingSlot(around, rankingWindow.nextRank);
        if (slotMarker !== null) {
          rankings.push({
            rankingKind: rankingWindow.kind,
            positionRank: rankingWindow.nextRank,
            playerId: player.playerId,
            webName: player.webName,
            rawQuote: buildSentenceQuote(windowText, startIdx, endIdx),
            startSec: windowStartSec
          });
          rankingWindow.seenPlayers.add(player.playerId);
          rankingWindow.nextRank++;
          if (rankingWindow.nextRank > 10) rankingWindow = null;
        }
      }

      // §1b numeric claims — does the surrounding window contain a stat we
      // recognise? Use the wider 80-char around window so "0.7 xG per 90"
      // captures even when the number is on the other side of the player's
      // name.
      for (const np of NUMERIC_PATTERNS) {
        const m = around.match(np.re);
        if (!m) continue;
        const val = Number(m[1]);
        if (!Number.isFinite(val)) continue;
        numericClaims.push({
          playerId: player.playerId,
          webName: player.webName,
          metric: np.metric,
          metricValue: val,
          metricUnit: np.unit ?? null,
          rawQuote: buildSentenceQuote(windowText, startIdx, endIdx),
          startSec: windowStartSec
        });
      }

      // §1a-fix — local "X to Y" / "X for Y" direction detection.
      // A creator saying "Saka to Palmer" means PALMER comes IN (buy). We
      // need to recognise this BEFORE the section-inversion rule fires,
      // because the section header that opened the segment ("transfers
      // out") would otherwise flip the buy interpretation to a sell.
      //
      // Rules:
      //   - "<word> to <PLAYER>"  → PLAYER is incoming (buying)
      //   - "<word> for <PLAYER>" → PLAYER is incoming (buying)
      //   - "<PLAYER> to <word>"  → PLAYER is outgoing (selling)
      //   - "<PLAYER> for <word>" → PLAYER is outgoing (selling)
      // We look in a tight ±40-char window so we don't get fooled by
      // unrelated uses of "to" / "for" further away in the sentence.
      const tightBefore = before.slice(-40);
      const tightAfter  = after.slice(0, 40);
      const isIncomingSwap = /\b\w+\s+(?:to|for)\s*$/i.test(tightBefore);
      const isOutgoingSwap = /^\s*(?:to|for)\s+\w/i.test(tightAfter);

      // Main signal panel.
      for (const pat of PATTERNS) {
        let hit = false;
        if (pat.beforeOnly)      hit = pat.re.test(before);
        else if (pat.afterOnly)  hit = pat.re.test(after);
        else                     hit = pat.re.test(around);
        if (!hit) continue;

        const rawQuote = buildSentenceQuote(windowText, startIdx, endIdx);

        // Resolve the signal kind in priority order:
        //   1. Direction detection wins — if the player is on the right
        //      side of "X to/for PLAYER", they're a buy no matter what
        //      section the creator was in.
        //   2. Otherwise, section context inverts buy↔sell as before,
        //      but ONLY when no direction was detected.
        let kind: SignalKind = pat.kind;
        if (isIncomingSwap) {
          kind = 'buying';
        } else if (isOutgoingSwap) {
          kind = 'selling';
        } else if (currentSection === 'transfers_out' || currentSection === 'avoid') {
          // Section context: in a transfers-out segment a "love" / "must
          // own" hit usually means the creator is reflecting on why they
          // can't quite let the player go — flip toward selling.
          if (kind === 'recommend' || kind === 'buying' || kind === 'watching') {
            kind = 'selling';
          } else if (kind === 'start' && currentSection === 'avoid') {
            kind = 'bench';
          }
        } else if (currentSection === 'transfers_in') {
          if (kind === 'selling') kind = 'buying';
        }

        signals.push({
          playerId: player.playerId,
          webName: player.webName,
          signalKind: kind,
          // Halve confidence on ambiguous surname collisions — the reviewer
          // should re-check which player is meant. Bump confidence slightly
          // when the section context matches the signal kind (signal said
          // inside its "expected" section is stronger evidence).
          confidence: Number((
            pat.baseConfidence
            * (ambiguous ? 0.5 : 1)
            * sectionConfidenceBoost(kind, currentSection)
          ).toFixed(3)),
          rawQuote,
          startSec: windowStartSec,
          videoSection: currentSection
        });
      }
    }
  }

  return {
    signals: dedupe(signals),
    numericClaims: dedupeNumericClaims(numericClaims),
    rankings
  };
}

/** Look for the next-rank slot marker in the surrounding text. */
function matchRankingSlot(around: string, rank: number): string | null {
  const ordinals = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const ordinal = ordinals[rank];
  // Numeric "1)" / "1." / "(1)" — most common
  const numRe = new RegExp(`(?:^|[^\\d])${rank}\\s*(?:\\)|\\.|\\:)`, 'i');
  if (numRe.test(around)) return `${rank}`;
  // "number two" / "number 2" / "second" / "third"
  const wordRe = new RegExp(`\\bnumber\\s*${rank}\\b|\\bnumber\\s*${ordinal}\\b`, 'i');
  if (ordinal && wordRe.test(around)) return ordinal;
  return null;
}

/** Section context boosts confidence when signal kind matches the section. */
function sectionConfidenceBoost(kind: SignalKind, section: VideoSection | null): number {
  if (!section) return 1;
  if (section === 'transfers_in'  && (kind === 'buying'    || kind === 'recommend'))  return 1.15;
  if (section === 'transfers_out' && (kind === 'selling'   || kind === 'bench'))      return 1.15;
  if (section === 'captains'      && (kind === 'recommend'))                          return 1.15;
  if (section === 'avoid'         && (kind === 'selling'   || kind === 'injury'))     return 1.15;
  if (section === 'differentials' && (kind === 'recommend' || kind === 'watching'))   return 1.10;
  return 1;
}

/**
 * Collapse near-duplicate numeric claims — same player + metric within 30s.
 * Keep the most-recent rendition (later quotes tend to be in fuller context).
 */
function dedupeNumericClaims(claims: NumericClaim[]): NumericClaim[] {
  claims.sort((a, b) =>
    a.playerId - b.playerId ||
    a.metric.localeCompare(b.metric) ||
    a.startSec - b.startSec
  );
  const out: NumericClaim[] = [];
  for (const c of claims) {
    const prev = out[out.length - 1];
    if (prev &&
        prev.playerId === c.playerId &&
        prev.metric === c.metric &&
        Math.abs(prev.startSec - c.startSec) <= 30) {
      out[out.length - 1] = c;
      continue;
    }
    out.push(c);
  }
  return out;
}

/**
 * Within a single video, collapse near-duplicates: same player + same kind
 * within a 30-second sliding window. Keep the highest-confidence one.
 */
function dedupe(signals: ExtractedSignal[]): ExtractedSignal[] {
  signals.sort((a, b) =>
    a.playerId - b.playerId ||
    a.signalKind.localeCompare(b.signalKind) ||
    a.startSec - b.startSec
  );
  const out: ExtractedSignal[] = [];
  for (const s of signals) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.playerId === s.playerId &&
      prev.signalKind === s.signalKind &&
      Math.abs(prev.startSec - s.startSec) <= 30
    ) {
      if (s.confidence > prev.confidence) out[out.length - 1] = s;
      continue;
    }
    out.push(s);
  }
  return out;
}

/**
 * Build the player lexicon from the DB players table. Aliases are a small
 * curated map of common nicknames the regex won't otherwise catch.
 *
 * CALIBRATION RULES (learned from real ingests):
 *
 *   1. Don't include a standalone first name unless it's globally unique
 *      ("Mo Salah" yes; "Bruno" no — collides with Guimarães; "Erling"
 *      yes; but we keep things conservative and prefer "erling haaland").
 *
 *   2. When two FPL players share a surname (Lewis Hall vs Dewsbury-Hall,
 *      multiple Williams etc.), the regex emits an ambiguous match and
 *      halves confidence. To kill the ambiguity, list the distinguishing
 *      form ("Dewsbury Hall", "Daniel James") as an alias on the player
 *      we DO want to match.
 *
 *   3. Compound / hyphenated surnames need an unhyphenated variant —
 *      transcripts often drop the hyphen ("Alexander Arnold",
 *      "Dewsbury Hall"). Add both forms.
 */
const ALIASES: Record<string, string[]> = {
  // B.Fernandes — DROPPED the standalone "bruno" (collided with
  // Bruno Guimarães of Newcastle). Still matches via full name or "Bruno F".
  'B.Fernandes':   ['fernandes', 'bruno fernandes', 'bruno f', 'b. fernandes'],
  // Bruno Guimarães (NEW) — explicit alias set so creators saying "Bruno G"
  // resolve correctly rather than misfiring to Fernandes.
  'Bruno G.':      ['bruno g', 'bruno guimaraes', 'bruno guimarães', 'guimaraes', 'guimarães'],
  'De Bruyne':     ['kdb', 'de bruyne'],
  'Saka':          ['saka'],
  'Salah':         ['mo salah', 'salah'],
  // Removed standalone "erling" — too generic.
  'Haaland':       ['haaland', 'erling haaland'],
  // Removed standalone "sonny" — keeping nickname is fine, dropping "son"
  // surname from needles (see SURNAME_STOPWORDS) so we don't match the
  // English word "son".
  'Son':           ['sonny', 'son heung-min', 'heung-min'],
  'Trent':         ['taa', 'trent', 'alexander-arnold', 'alexander arnold'],
  'Saliba':        ['saliba'],
  'Palmer':        ['cole palmer', 'palmer'],
  'Watkins':       ['ollie watkins', 'watkins'],
  'Isak':          ['alexander isak', 'isak'],
  'Mbeumo':        ['mbeumo', 'bryan mbeumo'],
  // Dewsbury-Hall — alias the space-separated and lone "dewsbury" forms so
  // transcripts that drop the hyphen resolve here, not to Lewis Hall.
  'Dewsbury-Hall': ['dewsbury-hall', 'dewsbury hall', 'kiernan dewsbury-hall', 'dewsbury']
};

/**
 * Surnames we deliberately DON'T match against the transcript needle regex.
 * Either common English words that happen to also be FPL surnames (almost
 * always misfires) or players we know are inactive/departed. The player
 * is still findable via aliases — only the surname needle is dropped.
 */
const SURNAME_STOPWORDS = new Set<string>([
  // English-word homographs that have caused noise on the Creator Board.
  'lucky', 'free', 'fine', 'real', 'good', 'bad', 'true', 'false',
  'just', 'only', 'very', 'most', 'best', 'first', 'last',
  // Common short words that occasionally appear in FPL rosters.
  'son',  // intentionally — Heung-min is matchable via nickname aliases.
]);

export function buildLexicon(players: Array<{
  id: number; web_name: string; first_name: string; second_name: string;
}>): PlayerLexicon[] {
  return players.map(p => {
    const surname = (p.second_name.split(/\s+/).pop() ?? p.web_name).toLowerCase();
    return {
      playerId: p.id,
      webName: p.web_name,
      surname,
      fullName: `${p.first_name} ${p.second_name}`.toLowerCase(),
      aliases: ALIASES[p.web_name] ?? []
    };
  });
}

/* ---------------------------------------------------------------------------
 * Sentence-aware raw-quote builder.
 *
 * Old behaviour: take ±60 chars around the player mention. That truncated
 * mid-word constantly ("…sula's 13pointer…", "…ively left out…").
 *
 * New behaviour: grow the quote outward to the nearest sentence boundary on
 * each side, capped at MAX_RADIUS chars. If no sentence boundary is found
 * within the radius, snap to a word boundary instead so we never start or
 * end mid-word.
 *
 * Why both: YouTube ASR transcripts SOMETIMES have proper punctuation (when
 * the creator's diction is clear or YouTube's auto-punctuation kicks in)
 * but often don't. Falling through to a word-boundary fallback means we
 * get reasonable quotes either way.
 * -------------------------------------------------------------------------*/
function buildSentenceQuote(text: string, mentionStart: number, mentionEnd: number): string {
  // Max characters to extend on each side. Tuned so quotes capture the
  // creator's full thought (~50-80 words = 1-3 sentences). Was 180.
  const MAX_RADIUS = 280;
  // How many sentence terminators to capture FORWARD. 2 = current sentence
  // plus the next one — gives much fuller context (e.g. "Gyökeres to
  // Bowen. I could have a look at selling Cherki out." instead of just
  // truncating at the first period).
  const FORWARD_SENTENCES = 2;

  // ----- Backward: walk back to the start of the current sentence -----
  // We want to begin at a clean sentence boundary, never mid-word.
  const backStart = Math.max(0, mentionStart - MAX_RADIUS);
  const before = text.slice(backStart, mentionStart);
  const sentRe = /[.!?]\s+/g;
  let lastSentEnd = -1;     // position AFTER the last terminator in `before`
  let m: RegExpExecArray | null;
  while ((m = sentRe.exec(before)) !== null) {
    lastSentEnd = m.index + m[0].length;
  }
  let start: number;
  if (lastSentEnd >= 0) {
    start = backStart + lastSentEnd;
  } else if (backStart === 0) {
    start = 0;
  } else {
    // No sentence terminator inside the window. Snap to the next word
    // boundary so we don't begin mid-word.
    start = backStart;
    while (start < mentionStart && /\S/.test(text[start] ?? '')) start++;
    while (start < mentionStart && /\s/.test(text[start] ?? '')) start++;
  }

  // ----- Forward: capture up to FORWARD_SENTENCES sentence endings ----
  // Take the position of the Nth terminator inside the lookahead window,
  // not the first — gives meaningfully more context after a player mention.
  const fwdEnd = Math.min(text.length, mentionEnd + MAX_RADIUS);
  const after = text.slice(mentionEnd, fwdEnd);
  const fwdRe = /[.!?](?:\s|$)/g;
  let nthTermEnd = -1;     // 1-indexed position past the Nth terminator
  let count = 0;
  while ((m = fwdRe.exec(after)) !== null) {
    count++;
    nthTermEnd = m.index + 1; // include the terminator character itself
    if (count >= FORWARD_SENTENCES) break;
  }
  let end: number;
  if (nthTermEnd >= 0) {
    end = mentionEnd + nthTermEnd;
  } else if (fwdEnd === text.length) {
    end = text.length;
  } else {
    end = fwdEnd;
    while (end > mentionEnd && /\S/.test(text[end - 1] ?? '')) end--;
  }

  // Guard rails — never emit a quote shorter than the mention itself.
  if (end <= mentionStart) end = Math.min(text.length, mentionEnd + 60);
  if (start >= mentionEnd) start = Math.max(0, mentionStart - 60);

  return text.slice(start, end).trim();
}
