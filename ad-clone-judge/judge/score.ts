/** Scoring, regeneration policy, and residual-weakness reporting for the
 * ad-clone judge stage (Plan 5). All functions here are pure — no I/O, no
 * mutation of inputs — so the orchestrator can call them freely between
 * passes without side effects. `applyRefinement` (the one impure step that
 * persists the regeneration decision) lives in `./refine.ts`.
 */

import { scrubForPrompt, assertNoLeak, stripOverlayLanguage } from "../generate/scrub";
import { BURN_BLUEPRINT_OVERLAYS } from "../assemble/timeline";
import type { AssembleSegment } from "../assemble/types";
import type { Blueprint } from "../strategize/types";
import type { JudgeShotComparison } from "./types";

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Scoring v2 (Plan 6 Task 6) severity weights: a severity-1 (subtle) note
 *  costs far less than a severity-3 (structural) one, instead of the v1
 *  formula's linear 1/2/3 points. A severity-3 divergence alone still
 *  saturates a shot's penalty at "fully wrong" (weight 1.0). */
const SEVERITY_WEIGHT: Record<1 | 2 | 3, number> = { 1: 0.15, 2: 0.35, 3: 1.0 };

/**
 * The operator-facing "is this shot good enough" line, used by the glass box
 * to colour a per-shot score. NOT a policy input: regeneration is chosen by
 * `selectRegenerations` off the `diverged` verdict, never off this number.
 *
 * 0.85 is not arbitrary — under SEVERITY_WEIGHT it is exactly the score of a
 * shot carrying ONE severity-1 (subtle) divergence, i.e. "at most one nitpick".
 * Anything coarser (a severity-2, or two severity-1s) falls below it.
 */
export const SHOT_PASS_THRESHOLD = 0.85;

/**
 * One shot's UNROUNDED penalty — `min(1, sum of its divergences' severity
 * weights)`. The single term both `shotScore` and `scorePass` are built from;
 * kept unrounded so the pass average is computed at full precision (rounding
 * per shot first would let 3dp error accumulate across shots and shift the
 * pass score).
 */
function shotPenalty(shot: JudgeShotComparison): number {
  const weightedSum = shot.divergences.reduce((acc, d) => acc + SEVERITY_WEIGHT[d.severity], 0);
  return Math.min(1, weightedSum);
}

/**
 * One shot's own 0..1 score. This is the per-shot term `scorePass` averages,
 * exposed so the glass box can show a shot-level number that provably
 * reconciles with the pass score instead of inventing a parallel formula.
 */
export function shotScore(shot: JudgeShotComparison): number {
  return round3(1 - shotPenalty(shot));
}

/**
 * Scoring v2: per-shot penalty is `min(1, sum of its divergences' severity
 * weights)` — several subtle (severity-1) notes no longer add up to a
 * structural failure the way 3 raw severity points used to (a single-shot
 * ad with three severity-1 divergences now scores 0.55, not 0). The pass
 * score is `round3(1 - average per-shot penalty)`. Empty shots (nothing to
 * judge) is treated as a perfect pass, not a divide-by-zero.
 *
 * Shares `shotPenalty` with `shotScore` so the pass score and the per-shot
 * scores can never drift apart, while still averaging the UNROUNDED penalty
 * — the output is bit-identical to the pre-extraction formula.
 */
export function scorePass(shots: JudgeShotComparison[]): number {
  if (shots.length === 0) return 1.0;
  let totalPenalty = 0;
  for (const shot of shots) {
    totalPenalty += shotPenalty(shot);
  }
  return round3(1 - totalPenalty / shots.length);
}

/** A pass has converged when no shot carries a "diverged" verdict. */
export function passConverged(shots: JudgeShotComparison[]): boolean {
  return !shots.some((s) => s.verdict === "diverged");
}

/**
 * Regeneration candidates are `kind === "clip"` shots with verdict
 * "diverged" AND at least one divergence that is NOT "overlay-layout" —
 * an overlay-only divergence never earns a regeneration, it drives
 * `needsReassembleOnly` instead (the burn-fix path re-runs assemble, not
 * generate). Candidates are ranked by the severity-sum of their
 * non-overlay-layout divergences descending, tied broken by index
 * ascending, and truncated to `cap`.
 */
export function selectRegenerations(shots: JudgeShotComparison[], cap = 4): number[] {
  const candidates = shots
    .filter((s) => s.kind === "clip" && s.verdict === "diverged")
    .map((s) => {
      const nonOverlay = s.divergences.filter((d) => d.dimension !== "overlay-layout");
      const severitySum = nonOverlay.reduce((acc, d) => acc + d.severity, 0);
      return { index: s.index, severitySum, hasNonOverlay: nonOverlay.length > 0 };
    })
    .filter((c) => c.hasNonOverlay);

  candidates.sort((a, b) => {
    if (b.severitySum !== a.severitySum) return b.severitySum - a.severitySum;
    return a.index - b.index;
  });

  return candidates.slice(0, cap).map((c) => c.index);
}

/**
 * The re-assemble-only (overlay burn-fix) path: true when any RENDERED
 * (kind === "clip") shot whose Blueprint shot carries a non-null overlay
 * either (a) has an "overlay-layout" divergence, or (b) its matching
 * AssembleSegment lacks `overlayBurned` (missing segment counts as
 * lacking it). Card shots never drive this — cards are composed images,
 * not burned footage.
 *
 * Short-circuits to `false` while burning is disabled: the ONLY repair a
 * re-assemble can apply is an overlay burn, so with the burn off every
 * overlay shot permanently satisfies `lacksBurn` and each non-converged
 * pass would pay for a full re-assemble that cannot change a single frame.
 * `burnOverlays` is a parameter (not a bare constant read) so the tests
 * covering the burn-fix path can still exercise it.
 */
export function needsReassembleOnly(
  shots: JudgeShotComparison[],
  segments: AssembleSegment[],
  blueprint: Blueprint,
  burnOverlays: boolean = BURN_BLUEPRINT_OVERLAYS,
): boolean {
  if (!burnOverlays) return false;

  const segmentByIndex = new Map(segments.map((s) => [s.index, s]));
  const blueprintByIndex = new Map(blueprint.shots.map((s) => [s.index, s]));

  return shots.some((shot) => {
    if (shot.kind !== "clip") return false;
    const bpShot = blueprintByIndex.get(shot.index);
    if (!bpShot || bpShot.overlay === null) return false;

    const hasOverlayLayoutDivergence = shot.divergences.some((d) => d.dimension === "overlay-layout");
    const segment = segmentByIndex.get(shot.index);
    const lacksBurn = !segment || !segment.overlayBurned;

    return hasOverlayLayoutDivergence || lacksBurn;
  });
}

/**
 * Per chosen shot, joins its divergences' `fix` strings ("; "-separated,
 * severity descending), scrubs the result against `dontCopy`, then
 * re-verifies with `assertNoLeak` as a hard backstop — scrubbing a single
 * dontCopy term can, in rare adversarial cases, EXPOSE a match for an
 * already-processed (earlier, longer) term by collapsing the text around
 * it (e.g. removing a short brand-mark word sandwiched between two halves
 * of a longer brand-mark phrase can leave the longer phrase contiguous).
 * A hint that fails the backstop lands in `dropped` — its shot still
 * regenerates, just hintless, never with untrusted text in the prompt.
 */
export function buildFixHints(
  shots: JudgeShotComparison[],
  chosen: number[],
  dontCopy: Blueprint["dontCopy"],
): { hints: Record<number, string>; dropped: number[] } {
  const hints: Record<number, string> = {};
  const dropped: number[] = [];
  const shotByIndex = new Map(shots.map((s) => [s.index, s]));

  for (const index of chosen) {
    const shot = shotByIndex.get(index);
    if (!shot || shot.divergences.length === 0) continue;

    const joined = [...shot.divergences]
      .sort((a, b) => b.severity - a.severity)
      .map((d) => d.fix)
      .join("; ");

    // Same two-step as still-loop.ts: scrubForPrompt kills the competitor's
    // overlay WORDS, stripOverlayLanguage kills the instruction to re-add an
    // overlay at all. A judge hint is appended verbatim to the regenerated
    // shot's imagePrompt, so an "add the offer card back" fix here re-opens
    // exactly the leak the still-loop guard closes.
    const scrubbed = stripOverlayLanguage(scrubForPrompt(joined, dontCopy));
    try {
      assertNoLeak([scrubbed], dontCopy);
      hints[index] = scrubbed;
    } catch {
      dropped.push(index);
    }
  }

  return { hints, dropped };
}

/**
 * Human-readable residual-weakness lines for the operator-facing judge
 * summary: one line per divergence of severity >= 2, PLUS every card-shot
 * divergence regardless of severity (card content is fully LLM-authored,
 * so even subtle divergences are worth surfacing).
 */
export function weaknessSummary(shots: JudgeShotComparison[]): string[] {
  const lines: string[] = [];
  for (const shot of shots) {
    for (const d of shot.divergences) {
      if (d.severity >= 2 || shot.kind === "card") {
        lines.push(`shot ${shot.index} (${shot.kind}): ${d.dimension} — ${d.description}`);
      }
    }
  }
  return lines;
}

// --- Refinement cost ceiling (Plan 6 Task 6, duration-aware since the F3 pre-E2E fix) ---

/** A still-loop regen's still+compare spend, independent of duration — the
 *  still-first convergence loop (still-loop.ts) is bounded at <=3 attempts
 *  regardless of how long the eventual clip runs. */
export const REFINEMENT_STILL_COST_PER_SHOT_USD = 0.30;
/** Per-second Kling video cost for the ONE winning still's video render,
 *  scaled by the chosen shots' average duration. F3 fix: the old flat
 *  $0.55/shot predated the still-loop and badly underpriced a real regen —
 *  up to 3 stills + 3 compares (~$0.30) PLUS one duration-scaled Kling video
 *  render (~$1.5-2 for a 12s clip), not a single flat number. */
export const REFINEMENT_VIDEO_COST_PER_SHOT_SECOND_USD = 0.12;
/** The reassemble pass itself — charged even on a zero-regen (overlay
 *  burn-fix) refinement, since assemble still re-runs. */
export const REFINEMENT_REASSEMBLE_COST_USD = 0.05;

/** Finding 11: a talking-shot regen never renders through the ordinary
 *  silent Kling model at REFINEMENT_VIDEO_COST_PER_SHOT_SECOND_USD — it
 *  renders via Kling Omni O3-pro (`sound: true`, native lip-synced speech),
 *  a materially pricier per-second rate that also carries an audio-
 *  generation surcharge margin. Mirrors the still/silent-video constants
 *  above: an approximation for budget-gating purposes, not a live provider
 *  quote. */
export const REFINEMENT_TALKING_VIDEO_COST_PER_SHOT_SECOND_USD = 0.25;
/** The re-bought native-speech script call (`writeVoScript`, Anthropic ADS
 *  lane) a talking-shot regen always re-pays for — `applyRefinement`'s
 *  reset stub drops `voScript`, so `generate/index.ts`'s reuse guard can't
 *  fire and a fresh script is written every refinement round. */
export const REFINEMENT_TALKING_SCRIPT_COST_USD = 0.05;

/** Mirrors `talking.ts`'s TALKING_MIN_RENDER_DURATION_S (kept as a local
 *  literal, not an import, so this pure-scoring module never depends on
 *  the generate stage) — O3's render floor: even a very short decomposed
 *  talking shot still renders (and bills) at least this many seconds. */
const TALKING_MIN_RENDER_DURATION_S = 7;

/**
 * Projected additional spend of running one more refinement round.
 *
 * Plain (silent-only) call: `chosenCount * (REFINEMENT_STILL_COST_PER_SHOT_USD +
 * REFINEMENT_VIDEO_COST_PER_SHOT_SECOND_USD * avgShotDurationS) +
 * REFINEMENT_REASSEMBLE_COST_USD`. Integer-cent math avoids float-addition
 * artifacts. `avgShotDurationS` is irrelevant (and safe to pass as 0) when
 * `chosenCount` is 0 — it only ever multiplies a zero shot count.
 *
 * Finding 11: when `talkingShotDecomposedDurationS` is supplied, exactly
 * ONE of the `chosenCount` shots (v1 scope: at most one native-speech shot
 * per run, `talking.ts`) is priced separately via the talking-aware
 * formula — its render duration floored at O3's 7s minimum
 * (`max(7, ceil(decomposedDurationS))`, mirroring `talkingRenderDurationSec`'s
 * own floor math) at `REFINEMENT_TALKING_VIDEO_COST_PER_SHOT_SECOND_USD`,
 * plus the still-loop cost every shot pays, plus the re-bought script call.
 * The remaining `chosenCount - 1` shots still price at the plain silent
 * formula off `avgShotDurationS` (the caller's average of the OTHER chosen
 * shots). Both branches share a single `REFINEMENT_REASSEMBLE_COST_USD`.
 */
export function projectedRefinementCostUsd(
  chosenCount: number,
  avgShotDurationS: number,
  talkingShotDecomposedDurationS?: number | null,
): number {
  const hasTalkingShot = talkingShotDecomposedDurationS != null;
  const silentCount = hasTalkingShot ? Math.max(0, chosenCount - 1) : chosenCount;
  const silentPerShotUsd = REFINEMENT_STILL_COST_PER_SHOT_USD + REFINEMENT_VIDEO_COST_PER_SHOT_SECOND_USD * avgShotDurationS;

  let cents = Math.round(silentCount * silentPerShotUsd * 100);

  if (hasTalkingShot) {
    const renderDurationS = Math.max(TALKING_MIN_RENDER_DURATION_S, Math.ceil(talkingShotDecomposedDurationS));
    const talkingUsd =
      REFINEMENT_STILL_COST_PER_SHOT_USD +
      REFINEMENT_TALKING_VIDEO_COST_PER_SHOT_SECOND_USD * renderDurationS +
      REFINEMENT_TALKING_SCRIPT_COST_USD;
    cents += Math.round(talkingUsd * 100);
  }

  cents += Math.round(REFINEMENT_REASSEMBLE_COST_USD * 100);
  return cents / 100;
}

/**
 * Airwallex-payout-ceiling-style hard stop: true only when the run's cost
 * so far PLUS the projected cost of the next refinement round stays at or
 * under `maxRunUsd` (AD_CLONE_MAX_RUN_USD, default 12). A stubborn
 * multi-pass run that keeps finding actionable divergences can't silently
 * blow through the operator's budget — refinement is skipped, not the pass
 * itself (the pass already scored and is a valid candidate for best-of).
 */
export function refinementWithinBudget(
  currentRunCostUsd: number,
  chosenCount: number,
  avgShotDurationS: number,
  maxRunUsd: number,
  talkingShotDecomposedDurationS?: number | null,
): { allowed: boolean; projectedCostUsd: number; wouldTotalUsd: number } {
  const projectedCostUsd = projectedRefinementCostUsd(chosenCount, avgShotDurationS, talkingShotDecomposedDurationS);
  const wouldTotalUsd = Math.round((currentRunCostUsd + projectedCostUsd) * 100) / 100;
  return { allowed: wouldTotalUsd <= maxRunUsd, projectedCostUsd, wouldTotalUsd };
}
