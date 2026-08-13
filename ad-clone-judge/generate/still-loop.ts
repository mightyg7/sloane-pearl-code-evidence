/**
 * Still-first convergence loop — Plan 6 Task 3.
 *
 * Before spending on a Kling video render, a persona-tryon shot's STILL is
 * iterated through renderClip's `stillsOnly` short-circuit and a cheap
 * sonnet vision compare (`compareShot` in `mode: "still"`) against the
 * REFERENCE shot's own mid-frame — catching composition/framing/pose/
 * lighting/persona fidelity misses ~10x cheaper than catching them after a
 * full Kling render. The generate orchestrator calls this ONCE per
 * persona-tryon shot, then renders exactly ONE video from the winning
 * still via `renderClip`'s `precomputedStillR2Key`.
 *
 * Attempt loop: render (stillsOnly) -> compare (mode "still") -> if verdict
 * "diverged" and attempts remain, append the joined scrubbed+leak-checked
 * fixes to `spec.imagePrompt` (" ADJUSTMENT FROM REVIEW: ...", the existing
 * shot-specs.ts convention) and retry -> best attempt by lowest NON-overlay
 * severity sum (ties -> earliest attempt, no extra render).
 *
 * Durable resume (`[[resumable-expensive-generation]]`): `deps.priorAttempts`
 * seeds the loop with attempts a previous (killed/restarted) run already
 * paid for and checkpointed — the prompt is reconstructed by replaying
 * their `fixApplied` chain, numbering continues from
 * `priorAttempts.length + 1`, and a converged or budget-exhausted prior
 * state renders nothing new ($0 on this call). `deps.onAttempt` fires once
 * per freshly-rendered attempt so a caller can checkpoint progress mid-loop
 * instead of only after the whole shot completes.
 */

import { renderClip, type RenderClipOptions } from "@/lib/ugc-pipeline/render-clip";
import type { ClipSpec, RenderedClip } from "@/lib/ugc-pipeline/types";
import { compareShot, loadShotFramePair, type OverlayContext } from "../judge/compare";
import { compareProductFidelity, type ProductFidelityResult } from "../judge/product-fidelity";
import { scrubForPrompt, assertNoLeak, stripOverlayLanguage } from "./scrub";
import type { Blueprint, BlueprintShot } from "../strategize/types";
import type { StillAttempt } from "./types";

/** Global Constraint: ≤3 still attempts per shot (1 initial + 2 retries). */
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Accumulated non-overlay severity at or below which a still is accepted
 * without spending another attempt.
 *
 * The loop used to stop on the VERDICT LABEL alone — anything not "diverged"
 * ended it, no matter how much severity came attached. Live finding (floral
 * run cmrvyws5a): shot 3 went `diverged(7)` then `minor(5)` and stopped there
 * with an attempt still unused; its framing was visibly wider than the
 * reference, and the composition judge had in fact reported exactly that. A
 * "minor" carrying severity 5 is worse than some "diverged"s, so the label is
 * the wrong thing to trust.
 *
 * 2 keeps genuinely-close stills cheap (a single sev-1 or sev-2 nit still
 * stops at one attempt) while giving real misses the retries they were always
 * budgeted. Extra attempts can only improve the outcome — best-of selection
 * keeps the lowest-severity attempt regardless — so the cost of raising this
 * bar is spend, never quality.
 */
export const STILL_ACCEPT_MAX_SEVERITY = 2;

/** HARD render-failure retries per still attempt. AtlasCloud reports its
 *  "Model failed to generate expected content" / bad_request as a PERMANENT
 *  failure (see atlascloud/run.ts isTransientError → hard), but in practice
 *  it is overwhelmingly a transient burst flake that a FRESH run clears —
 *  the same thing the ABO lane hardened against. A hard failure used to kill
 *  a shot on attempt 1, BEFORE the divergence loop below could even run
 *  (the render produced no image to compare). We now re-render — a brand-new
 *  AtlasCloud run each try — up to this many times before giving up. Failed
 *  renders return fast and bill $0 (failedClip), so the only cost of a retry
 *  is a short backoff. This is orthogonal to the divergence loop: THIS clears
 *  "no image produced"; the outer loop refines "image produced but wrong". */
const DEFAULT_RENDER_TRIES = 3;
/** Backoff before render retry 2 and 3 (ms). Index clamps for tries > 3. */
const RENDER_RETRY_BACKOFF_MS = [1500, 3000];
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Render a still, retrying a HARD failure (no image produced) with a fresh
 * run up to `tries` times. Divergence is NOT handled here — a rendered-but-
 * wrong still returns `status: "ready"` and is judged by the caller's loop.
 * Returns the successful clip, or the last failed clip once tries are spent
 * (the caller throws on it, preserving the pre-retry failure behavior).
 */
async function renderStillWithRetry(
  render: typeof renderClip,
  spec: ClipSpec,
  opts: RenderClipOptions,
  tries: number,
  sleep: (ms: number) => Promise<void>,
  shotIndex: number,
): Promise<RenderedClip> {
  let last: RenderedClip | null = null;
  for (let t = 1; t <= tries; t++) {
    const rendered = await render(spec, opts);
    if (rendered.status === "ready" && rendered.imageR2Key) return rendered;
    last = rendered;
    if (t < tries) {
      console.warn(
        `[ad-clone:still] shot ${shotIndex} render hard-failed (try ${t}/${tries}): ` +
          `${rendered.errorMessage ?? "no image output"} — retrying with a fresh run`,
      );
      await sleep(RENDER_RETRY_BACKOFF_MS[Math.min(t - 1, RENDER_RETRY_BACKOFF_MS.length - 1)]);
    }
  }
  return last as RenderedClip;
}

/** A still-loop comparison happens before assembly — no overlay is ever
 *  burned onto a pre-video still, so the reference's overlay state is
 *  irrelevant here (compare.ts's "still" mode also drops the
 *  overlay-layout dimension from the judged list entirely; this context is
 *  a defensive backstop, not the primary guard). */
const NO_OVERLAY_CONTEXT: OverlayContext = { originalHasOverlay: false, originalPosition: null, oursBurned: false };

const EMPTY_DONT_COPY: Blueprint["dontCopy"] = { overlayTexts: [], brandMarks: [], audioTrack: "" };

export interface RefineStillInput {
  spec: ClipSpec;
  referenceUrls: string[];
  referenceMidFrameKey: string;
  blueprintShot: BlueprintShot;
  styleRegister?: Blueprint["styleRegister"];
  maxAttempts?: number;
  /** HARD render-failure retries per attempt (fresh run each). Default
   *  DEFAULT_RENDER_TRIES; clamp-floored at 1, so `1` opts out (pre-retry
   *  behavior). Distinct from `maxAttempts` (the divergence loop). */
  renderTries?: number;
  /** Accumulated non-overlay severity accepted without another attempt.
   *  Defaults to STILL_ACCEPT_MAX_SEVERITY. Raise it to make the loop
   *  cheaper/laxer, lower it to chase composition harder. */
  acceptMaxSeverity?: number;
  /** Product-fidelity QC axis: when set, every attempt is ALSO judged on
   *  whether OUR product is convincingly present (compareProductFidelity),
   *  retry fixes target both axes, and — per operator decision — a best
   *  attempt whose product verdict still fails after the loop THROWS
   *  (product fidelity outranks composition). Omitted (shots with no
   *  product, or callers predating the axis) — byte-identical behavior. */
  productCheck?: {
    productTitle: string;
    productImageUrls: string[];
    presentation: "worn" | "held" | "displayed";
  };
}

export interface RefineStillDeps {
  render?: typeof renderClip;
  compare?: typeof compareShot;
  compareProduct?: typeof compareProductFidelity;
  loadPair?: typeof loadShotFramePair;
  /** Base renderClip options (aspectRatio, pollTimeoutMs, ...) — merged
   *  UNDER this loop's own `productImageUrls`/`stillsOnly`, which always
   *  win regardless of what's passed here. */
  renderOpts?: RenderClipOptions;
  /** Quarantine terms a retry's fix text must never leak — omitted callers
   *  get an empty (no-op) dontCopy, matching a Blueprint with nothing to
   *  quarantine. */
  dontCopy?: Blueprint["dontCopy"];
  /** Attempts a PRIOR (killed/restarted) run already paid for and
   *  checkpointed, in attempt-number order. When provided, the loop
   *  reconstructs the prompt from their `fixApplied` chain and resumes
   *  numbering from `priorAttempts.length + 1` instead of re-rendering
   *  them. Omitted (fresh shot) starts a brand-new loop at attempt 1. */
  priorAttempts?: StillAttempt[];
  /** Fired once per FRESHLY-rendered attempt (never for seeded
   *  priorAttempts) so the caller can durably checkpoint mid-loop progress
   *  instead of only after the whole shot completes. */
  onAttempt?: (attempt: StillAttempt) => Promise<void> | void;
  /** Backoff between hard-render-failure retries. Injectable so tests run
   *  instantly; defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RefineStillResult {
  bestStillR2Key: string;
  attempts: StillAttempt[];
  /** THIS call's own spend only — reused priorAttempts already paid for
   *  their own cost on a previous run and are not counted again here. */
  totalCostUsd: number;
  /** The winning attempt's own costSource — undefined when it (or an
   *  attempt seeded from before this field existed) never recorded one. */
  bestCostSource?: string;
}

/** Sum of every NON-"overlay-layout" divergence's severity — a pre-video
 *  still never carries an overlay, so an overlay-layout divergence (should
 *  the model emit one despite the still-mode prompt excluding it from the
 *  judged list) must not affect which attempt wins best-of. */
function nonOverlaySeveritySum(divergences: { dimension: string; severity: number }[]): number {
  return divergences.filter((d) => d.dimension !== "overlay-layout").reduce((sum, d) => sum + d.severity, 0);
}

/** Round-1 review fix (Finding 1): best-of selection must gate on
 *  text-presence BEFORE severitySum, not fold it in additively. The
 *  synthetic text-leak divergence (compare.ts's still-mode
 *  `ours_contains_text` gate) still contributes +3 to `severitySum`, but
 *  strict `a.severitySum < best.severitySum` treats that +3 as just another
 *  point of ordinary composition/framing severity — so a LATER, text-free
 *  attempt that happens to TIE the leaking attempt's severitySum on an
 *  unrelated divergence loses the tie (earliest wins) and the leaking
 *  still ships. Here, any attempt without a detected text leak beats any
 *  attempt with one, regardless of severitySum; only when both attempts
 *  agree on leak status does the comparison fall back to lowest
 *  severitySum (ties still favor the earliest attempt, preserving every
 *  pre-existing no-leak tie-break test). `hasTextLeak` defaults to `false`
 *  for attempts checkpointed before this field existed (durable-resume
 *  priorAttempts).
 *
 *  Round-1 review fix (Findings 1/3): a "pending" attempt (Finding 12's
 *  checkpoint for a billed render whose compare/loadPair then threw — the
 *  image was rendered but NEVER actually vision-judged) hardcodes
 *  `severitySum: 0`, which ties exactly the severitySum an honest "match"
 *  verdict also produces. Without an explicit pending-vs-judged gate here,
 *  that tie falls through to "earliest wins" and the never-verified pending
 *  image beats a LATER attempt that was actually re-rendered and confirmed
 *  to match — even after `alreadyConverged` correctly stops treating
 *  "pending" as converged and lets the retry loop run. This gate comes
 *  FIRST (before the leak gate): any actually-compared attempt (verdict
 *  "match"/"minor"/"diverged") beats a "pending" one regardless of leak
 *  status or severitySum, since "pending" carries no real leak/severity
 *  signal at all — it's a placeholder, not a judged result. */
function isBetterAttempt(candidate: StillAttempt, current: StillAttempt): boolean {
  const candidatePending = candidate.verdict === "pending";
  const currentPending = current.verdict === "pending";
  if (candidatePending !== currentPending) return !candidatePending;
  // Product-fidelity gate (two-axis QC): an attempt verifiably showing OUR
  // product beats any attempt showing the wrong/no product, regardless of
  // composition severity or leak status — product fidelity outranks
  // composition by operator decision. Attempts without a productVerdict
  // (axis not run) are neutral: absent !== "ours" must not count as "bad",
  // so only an explicit non-"ours" verdict loses here.
  const candidateProductBad = candidate.productVerdict !== undefined && candidate.productVerdict !== "ours";
  const currentProductBad = current.productVerdict !== undefined && current.productVerdict !== "ours";
  if (candidateProductBad !== currentProductBad) return !candidateProductBad;
  const candidateLeaks = candidate.hasTextLeak ?? false;
  const currentLeaks = current.hasTextLeak ?? false;
  if (candidateLeaks !== currentLeaks) return !candidateLeaks;
  return candidate.severitySum < current.severitySum;
}

export async function refineStillForShot(
  input: RefineStillInput,
  deps: RefineStillDeps = {},
): Promise<RefineStillResult> {
  const render = deps.render ?? renderClip;
  const compare = deps.compare ?? compareShot;
  const compareProduct = deps.compareProduct ?? compareProductFidelity;
  const loadPair = deps.loadPair ?? loadShotFramePair;
  const dontCopy = deps.dontCopy ?? EMPTY_DONT_COPY;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const acceptMaxSeverity = input.acceptMaxSeverity ?? STILL_ACCEPT_MAX_SEVERITY;
  const renderTries = Math.max(1, input.renderTries ?? DEFAULT_RENDER_TRIES);
  const sleep = deps.sleep ?? defaultSleep;
  const priorAttempts = deps.priorAttempts ?? [];

  const attempts: StillAttempt[] = [...priorAttempts];
  let totalCostUsd = 0;

  // Reconstruct the prompt exactly as it would have been going into the
  // next fresh attempt: the base prompt plus every prior fix, in order.
  let currentImagePrompt = input.spec.imagePrompt;
  for (const prior of priorAttempts) {
    if (prior.fixApplied) currentImagePrompt = `${currentImagePrompt} ADJUSTMENT FROM REVIEW: ${prior.fixApplied}`;
  }

  const lastPrior = priorAttempts.at(-1);
  // Round-1 review fix (Findings 1/3): a still ONLY converged if the last
  // prior attempt was ACTUALLY vision-compared and accepted ("match" or
  // "minor" — compare.ts's VERDICTS enum). The old `!== "diverged"` check
  // predates the "pending" verdict Finding 12 introduced (checkpointed when
  // a billed render's compare/loadPair throws, i.e. the image was NEVER
  // actually judged) — "pending" also satisfies `!== "diverged"`, so a
  // resumed/retried call used to treat an unverified image as converged and
  // skip the entire retry loop, shipping it straight through with zero
  // additional QC. Anything other than a terminal accepted verdict (a
  // future/unexpected verdict string included) must fall through to retry.
  // Severity-aware (see STILL_ACCEPT_MAX_SEVERITY): a checkpointed "minor"
  // carrying real severity is NOT converged — a resumed run should spend its
  // remaining attempts on it rather than shipping it because of the label.
  const alreadyConverged =
    !!lastPrior &&
    (lastPrior.verdict === "match" || lastPrior.verdict === "minor") &&
    lastPrior.severitySum <= acceptMaxSeverity;

  if (!alreadyConverged) {
    for (let attemptNum = priorAttempts.length + 1; attemptNum <= maxAttempts; attemptNum++) {
      const attemptSpec: ClipSpec = { ...input.spec, imagePrompt: currentImagePrompt };
      const rendered = await renderStillWithRetry(
        render,
        attemptSpec,
        { ...deps.renderOpts, productImageUrls: input.referenceUrls, stillsOnly: true },
        renderTries,
        sleep,
        input.blueprintShot.index,
      );

      if (rendered.status !== "ready" || !rendered.imageR2Key) {
        throw new Error(
          `refineStillForShot: still render failed on attempt ${attemptNum} (shot ${input.blueprintShot.index}) ` +
            `after ${renderTries} render ${renderTries === 1 ? "try" : "tries"}: ${rendered.errorMessage ?? "no image output"}`,
        );
      }
      const stillCostUsd = rendered.costUsd ?? 0;

      // Finding 12: the render above already billed `stillCostUsd` — if
      // loadPair, compare, or the leak-check below throws, that spend (and
      // the reusable imageR2Key) must not vanish from this call's
      // totalCostUsd/attempts/onAttempt, or a retry silently re-bills the
      // same image. `compareCostUsd`/`costAlreadyRolledUp` track exactly
      // how much of the attempt's cost was actually incurred by the time a
      // throw happens, so the catch below records precisely that (never
      // double-counted against the success path's own totalCostUsd bump).
      let compareCostUsd = 0;
      let costAlreadyRolledUp = false;
      try {
        const pair = await loadPair([input.referenceMidFrameKey], [rendered.imageR2Key]);
        const comparison = await compare({
          index: input.blueprintShot.index,
          kind: "clip",
          blueprintShot: input.blueprintShot,
          original: pair.original,
          draft: pair.draft,
          originalDurationS: 0,
          draftDurationS: 0,
          overlayContext: NO_OVERLAY_CONTEXT,
          mode: "still",
          styleRegister: input.styleRegister,
        });
        compareCostUsd = comparison.costUsd;

        // Axis 2 (product fidelity) — runs inside the same try so a throw
        // here checkpoints a "pending" attempt exactly like a composition-
        // compare throw (Finding 12 discipline; render spend preserved).
        let productResult: ProductFidelityResult | null = null;
        if (input.productCheck) {
          productResult = await compareProduct({
            stillR2Key: rendered.imageR2Key,
            productTitle: input.productCheck.productTitle,
            productImageUrls: input.productCheck.productImageUrls,
            presentation: input.productCheck.presentation,
          });
          compareCostUsd += productResult.costUsd;
        }
        const productFailed = !!productResult && productResult.verdict !== "ours";

        const severitySum = nonOverlaySeveritySum(comparison.divergences);
        const attemptCostUsd = stillCostUsd + compareCostUsd;
        totalCostUsd += attemptCostUsd;
        costAlreadyRolledUp = true;

        // Stop on the RESULT, not the label: a "minor" carrying more than
        // `acceptMaxSeverity` still has a real miss worth another attempt.
        const severityTooHigh = severitySum > acceptMaxSeverity;
        const needsAnotherAttempt = comparison.verdict === "diverged" || productFailed || severityTooHigh;
        const canRetry = needsAnotherAttempt && attemptNum < maxAttempts;
        let fixApplied: string | null = null;
        let productFixApplied: string | null = null;
        if (canRetry) {
          // Product fix FIRST — it outranks composition fixes in priority.
          const joinedFix = [
            ...(productFailed && productResult && productResult.fix.trim().length > 0 ? [productResult.fix] : []),
            ...comparison.divergences
              .filter((d) => d.dimension !== "overlay-layout")
              .map((d) => d.fix),
          ].join(" ");
          // stripOverlayLanguage AFTER the quarantine scrub: scrubForPrompt
          // removes the competitor's overlay WORDS, this removes the
          // instruction to re-add an overlay at all. The dimension filter
          // above cannot do it — run cms2v0yvs01cv1bnyxayjdh11 had the model
          // file "Re-add the offer text overlay" under "composition", not
          // "overlay-layout", and the hint went straight into the next
          // attempt's prompt.
          const scrubbedFix = stripOverlayLanguage(scrubForPrompt(joinedFix, dontCopy));
          if (scrubbedFix.trim().length > 0) {
            currentImagePrompt = `${currentImagePrompt} ADJUSTMENT FROM REVIEW: ${scrubbedFix}`;
            assertNoLeak([currentImagePrompt], dontCopy);
            fixApplied = scrubbedFix;
            if (productFailed && productResult) productFixApplied = productResult.fix;
          }
        }

        const attempt: StillAttempt = {
          attempt: attemptNum,
          imageR2Key: rendered.imageR2Key,
          severitySum,
          verdict: comparison.verdict,
          fixApplied,
          costUsd: attemptCostUsd,
          costSource: rendered.costSource,
          hasTextLeak: comparison.hasTextLeak ?? false,
          ...(productResult
            ? {
                productVerdict: productResult.verdict,
                productSeverity: productResult.severity,
                productFixApplied,
              }
            : {}),
        };
        attempts.push(attempt);
        await deps.onAttempt?.(attempt);

        if (!needsAnotherAttempt) break;
      } catch (err) {
        if (!costAlreadyRolledUp) totalCostUsd += stillCostUsd + compareCostUsd;
        const pendingAttempt: StillAttempt = {
          attempt: attemptNum,
          imageR2Key: rendered.imageR2Key,
          severitySum: 0,
          verdict: "pending",
          fixApplied: null,
          costUsd: stillCostUsd + compareCostUsd,
          costSource: rendered.costSource,
        };
        attempts.push(pendingAttempt);
        await deps.onAttempt?.(pendingAttempt);
        throw err;
      }
    }
  }

  let best = attempts[0];
  for (const a of attempts.slice(1)) {
    if (isBetterAttempt(a, best)) best = a;
  }

  // Terminal product-fidelity gate (operator decision: product fidelity
  // outranks composition). A clone whose best still shows the competitor's
  // product — or no product where one must appear — is worthless no matter
  // how well the composition matches; fail the shot loudly BEFORE the
  // $1+ video render instead of shipping a false success.
  if (input.productCheck && best.productVerdict !== undefined && best.productVerdict !== "ours") {
    throw new Error(
      `product fidelity failed for shot ${input.blueprintShot.index}: best still attempt shows ` +
        `${best.productVerdict === "no-product" ? "no product" : "the wrong product"} instead of ` +
        `"${input.productCheck.productTitle}" after ${attempts.length} attempt(s) - a clone advertising ` +
        `a competitor's product must fail loudly`,
    );
  }

  return { bestStillR2Key: best.imageR2Key, attempts, totalCostUsd, bestCostSource: best.costSource };
}
