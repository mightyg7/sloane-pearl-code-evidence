/**
 * Judge orchestrator — Plan 5 stage 5, extended to a bounded 3-pass loop
 * by Plan 6 Task 6.
 *
 * Bounded budget-aware visual judge: pass 1 extracts frames from OUR
 * assembled draft, compares every segment (clip AND card) against the
 * ORIGINAL reference video's decompose frames shot-by-shot, scores the
 * pass, and — only when unconverged AND something is actually actionable
 * (a regenerable clip divergence, or an overlay burn-fix) AND the
 * projected refinement cost keeps the run under `AD_CLONE_MAX_RUN_USD` —
 * regenerates the chosen shots and/or re-assembles, then judges the
 * refined draft again. This repeats up to the run's pass budget — the
 * operator's 2/3/5 selector (`AdCloneRunParams.maxJudgePasses`), defaulting
 * to `MAX_JUDGE_PASSES` (3) and hard-capped at `MAX_JUDGE_PASSES_CEILING`.
 * The final pass is always score-only (no pass N+1 exists, so nothing is
 * ever selected for regeneration on it). The BEST-SCORING pass's draft
 * (tie -> the later pass) wins `AdCloneRun.finalVideoR2Key` — explicitly
 * restoring an earlier pass's key when a later pass scores worse, since
 * `runAssemble`'s later call already overwrote it.
 *
 * Every sub-operation goes through `withStep` (mirrors `assemble/index.ts`
 * and `generate/index.ts`) so the operator sees per-pass, per-shot
 * progress/artifacts in the glass-box UI. Regeneration/re-assembly during
 * refinement is delegated to the real `runGenerate`/`runAssemble`
 * orchestrators — their own steps land under their own stages ("generate"
 * / "assemble"), which is a deliberate, accurate glass-box choice, not an
 * omission. A refinement blocked by the cost ceiling still gets its own
 * "Refine diverged shots" step, carrying a visible text note instead of
 * silently vanishing from the operator's view.
 */

import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { prisma } from "@/lib/db";
import { withStep, updateRun, rollupRunCost } from "../steps";
import type { StageContext } from "../run-job";
import type { StepArtifactRef } from "../types";
import type { Blueprint, BlueprintShot } from "../strategize/types";
import type { DecomposeResult } from "../decompose/types";
import type { GenerateResult } from "../generate/types";
import type { AssembleResult } from "../assemble/types";
import { runGenerate, type GenerateDeps } from "../generate";
import { runAssemble, type AssembleDeps } from "../assemble";
import { BURN_BLUEPRINT_OVERLAYS } from "../assemble/timeline";
import { getObjectBuffer } from "@/lib/storage/r2";
import { IMAGE_BUCKET } from "@/lib/storage/save-image";
import { segmentTimeRanges, extractDraftFrames } from "./frames";
import { loadShotFramePair, compareShot, type OverlayContext } from "./compare";
import {
  scorePass,
  passConverged,
  selectRegenerations,
  needsReassembleOnly,
  buildFixHints,
  weaknessSummary,
  refinementWithinBudget,
} from "./score";
import { applyRefinement } from "./refine";
import type { JudgeResult, JudgePass, JudgeShotComparison } from "./types";

/** Default bounded pass loop — 1 initial pass + up to 2 refinement rounds.
 *  Per-run overridable via `AdCloneRunParams.maxJudgePasses` (the operator's
 *  2/3/5 selector); see `resolveMaxPasses`. */
export const MAX_JUDGE_PASSES = 3;

/** Hard ceiling on the per-run override — a typo'd or hostile params value
 *  must not be able to spin the loop indefinitely. The real spend backstop
 *  is still `AD_CLONE_MAX_RUN_USD` (refinement is budget-gated between every
 *  pass); this is the belt to that brace. */
export const MAX_JUDGE_PASSES_CEILING = 5;

/**
 * Resolves this run's pass budget: an explicit `deps.maxPasses` wins (tests),
 * then the run's own `params.maxJudgePasses` (operator selector), else the
 * module default. Non-integer / out-of-range values fall back to the default
 * rather than throwing — a bad pass budget must never fail a run that has
 * already paid for generate + assemble.
 */
export function resolveMaxPasses(requested: number | undefined): number {
  if (requested === undefined || !Number.isInteger(requested)) return MAX_JUDGE_PASSES;
  if (requested < 1 || requested > MAX_JUDGE_PASSES_CEILING) return MAX_JUDGE_PASSES;
  return requested;
}

const DEFAULT_MAX_RUN_USD = 12;

/**
 * `AD_CLONE_MAX_RUN_USD` — read ONCE at module load, mirroring
 * `AD_CLONE_VO_VOICE_ID` in `assemble/vo.ts` (env is expected to be stable
 * for a process's lifetime). Malformed/unset falls back to the $12
 * default rather than failing closed: unlike an Airwallex payout, a
 * blocked refinement never moves money or loses data — the pass already
 * ran and stands as a valid best-of candidate, so the safe failure mode
 * here is "stop refining", not "crash the stage".
 */
function resolveMaxRunUsd(): number {
  const raw = process.env.AD_CLONE_MAX_RUN_USD;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_RUN_USD;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_RUN_USD;
}
const AD_CLONE_MAX_RUN_USD = resolveMaxRunUsd();

/** Only the fields this stage reads off the run row. */
export interface JudgeRunRow {
  blueprintJson: string | null;
  decomposeJson: string | null;
  generateJson: string | null;
  assembleJson: string | null;
  finalVideoR2Key: string | null;
}

export interface JudgeDeps {
  loadRunFn?: (runId: string) => Promise<JudgeRunRow | null>;
  withStepFn?: typeof withStep;
  updateRunFn?: typeof updateRun;
  extractFramesFn?: typeof extractDraftFrames;
  loadPairFn?: typeof loadShotFramePair;
  compareFn?: typeof compareShot;
  runGenerateFn?: typeof runGenerate;
  runAssembleFn?: typeof runAssemble;
  getObjectBufferFn?: typeof getObjectBuffer;
  /** Sums every step's costUsd for the run so far — the authoritative
   *  "current run cost" input to the refinement budget gate. Defaults to
   *  the real `rollupRunCost` (which also persists the total onto the run
   *  row, a harmless side effect). */
  rollupRunCostFn?: typeof rollupRunCost;
  /** Overrides `AD_CLONE_MAX_RUN_USD` for this call — defaults to the
   *  module-level env-resolved constant. Injectable so tests never depend
   *  on process.env. */
  maxRunUsd?: number;
  /** Overrides this run's pass budget, ahead of `ctx.params.maxJudgePasses`
   *  and the `MAX_JUDGE_PASSES` default. Injectable so tests can drive a
   *  1- or 2-pass loop without going through run params. */
  maxPasses?: number;
  /** Whether the assemble stage this judge drives will burn overlays. Gates
   *  the reassemble-only (burn-fix) path: with burning off there is nothing
   *  a re-assemble could repair, so asking for one is pure spend. Defaults
   *  to `assembleDeps.burnOverlays` — the switch the re-assemble would
   *  actually run under — falling back to `BURN_BLUEPRINT_OVERLAYS`. */
  burnOverlays?: boolean;
  generateDeps?: GenerateDeps;
  assembleDeps?: AssembleDeps;
}

function withDefaults(deps: JudgeDeps, paramsMaxPasses: number | undefined): Required<JudgeDeps> {
  return {
    maxPasses: resolveMaxPasses(deps.maxPasses ?? paramsMaxPasses),
    loadRunFn: deps.loadRunFn ?? ((runId: string) => prisma.adCloneRun.findUnique({ where: { id: runId } })),
    withStepFn: deps.withStepFn ?? withStep,
    updateRunFn: deps.updateRunFn ?? updateRun,
    extractFramesFn: deps.extractFramesFn ?? extractDraftFrames,
    loadPairFn: deps.loadPairFn ?? loadShotFramePair,
    compareFn: deps.compareFn ?? compareShot,
    runGenerateFn: deps.runGenerateFn ?? runGenerate,
    runAssembleFn: deps.runAssembleFn ?? runAssemble,
    getObjectBufferFn: deps.getObjectBufferFn ?? getObjectBuffer,
    rollupRunCostFn: deps.rollupRunCostFn ?? rollupRunCost,
    maxRunUsd: deps.maxRunUsd ?? AD_CLONE_MAX_RUN_USD,
    burnOverlays: deps.burnOverlays ?? deps.assembleDeps?.burnOverlays ?? BURN_BLUEPRINT_OVERLAYS,
    generateDeps: deps.generateDeps ?? {},
    assembleDeps: deps.assembleDeps ?? {},
  };
}

/** Regeneration cap — mirrors `selectRegenerations`'s own default. */
const REGEN_CAP = 4;

/**
 * F3 fix (Plan 6 pre-E2E wave): the refinement budget gate's cost
 * projection is duration-aware (score.ts's `projectedRefinementCostUsd`),
 * so it needs the CHOSEN shots' average real duration, read off the
 * decompose result (the same source of truth `runPass` already joins
 * against for `originalDurationS`). `chosenIndices` empty (reassemble-only
 * refinement, nothing regenerated) returns 0 — safe because
 * `projectedRefinementCostUsd`'s duration term only ever multiplies a zero
 * chosenCount.
 */
function avgChosenShotDurationS(chosenIndices: number[], decompose: DecomposeResult): number {
  if (chosenIndices.length === 0) return 0;
  const chosenSet = new Set(chosenIndices);
  const durations = decompose.shots.filter((s) => chosenSet.has(s.index)).map((s) => s.durationS);
  if (durations.length === 0) return 0;
  return durations.reduce((sum, d) => sum + d, 0) / durations.length;
}

/**
 * Round-1 review fix (Findings 2/4): `projectedRefinementCostUsd`/
 * `refinementWithinBudget` gained a talking-aware pricing branch (Finding
 * 11), but the real budget-gate call site never detected or passed it —
 * the new branch was dead code from `runJudge`'s perspective, so a
 * talking-shot regen round could still overshoot `AD_CLONE_MAX_RUN_USD` by
 * the ~$1-1.5 the plain silent-per-second rate undercounts it by. v1 scope
 * (mirrors `talking.ts`): at most one native-speech shot per run, so the
 * first `regenChosen` shot marked `speaksOnCamera: true` in the blueprint
 * is authoritative. Returns `null` when no chosen shot speaks on camera
 * (the ordinary silent-only projection applies unchanged) or when the
 * decompose result has no matching shot (never happens given
 * `chosenIndices` is drawn from the same `blueprint`/`decompose` this stage
 * already loaded, but keeps this pure and total rather than throwing).
 */
function findTalkingShot(chosenIndices: number[], blueprint: Blueprint): BlueprintShot | null {
  const chosenSet = new Set(chosenIndices);
  return blueprint.shots.find((s) => chosenSet.has(s.index) && s.speaksOnCamera) ?? null;
}

/**
 * Bug 4 fix: the pass loop always restarts at 1 on a fresh `runJudge`
 * invocation (`currentDraftKey` seeded from the run row, not from any
 * cross-invocation cursor), so a purely-pass-number-derived filename like
 * the old `final-pass${pass + 1}.mp4` can collide with — and silently
 * overwrite in R2 — a draft an EARLIER invocation already scored (the
 * exact crash-resume window the worker's auto-resume exists for). `n` is
 * the count of distinct draft keys already used THIS invocation (belt —
 * keeps the numbering human-legible); the 6-hex `crypto.randomBytes`
 * suffix is the actual collision-freedom guarantee, since `n` alone can't
 * see draft keys any PRIOR invocation already wrote. No `Date.now()`.
 *
 * Bug 10 fix: the same suffix threads into `buildCards`' filenames
 * (`assemble/index.ts`'s `cardFilenameSuffix` dep) so a re-assemble's
 * `card-<index>.png` writes don't collide with an earlier pass's cards
 * either.
 */
function nextPassArtifactSuffix(existingDraftKeys: string[]): string {
  const n = existingDraftKeys.length + 1;
  return `p${n}-${randomBytes(3).toString("hex")}`;
}

interface PassOutcome {
  shots: JudgeShotComparison[];
  convergenceScore: number;
  costUsd: number;
  converged: boolean;
  /** Empty on the FINAL pass (this run's `maxPasses`) — score-only, nothing
   *  is ever selected for regeneration since no further pass could use it. */
  regenChosen: number[];
  fixHints: Record<number, string>;
  droppedHints: number[];
  needsReassemble: boolean;
}

export async function runJudge(ctx: StageContext, deps: JudgeDeps = {}): Promise<JudgeResult> {
  const d = withDefaults(deps, ctx.params?.maxJudgePasses);

  // ── Step 1: load blueprint + decompose + generate + assemble + draft key ──
  let blueprint!: Blueprint;
  let decompose!: DecomposeResult;
  let generate!: GenerateResult;
  let assemble!: AssembleResult;
  let finalVideoR2Key!: string;

  await d.withStepFn(ctx.runId, "judge", "Load judge inputs", {}, async () => {
    const run = await d.loadRunFn(ctx.runId);
    if (!run || !run.blueprintJson || !run.decomposeJson || !run.generateJson || !run.assembleJson || !run.finalVideoR2Key) {
      throw new Error("judge requires a completed assemble - run stages 1-4 first");
    }
    try {
      blueprint = JSON.parse(run.blueprintJson) as Blueprint;
    } catch (err) {
      throw new Error(`corrupt blueprintJson: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      decompose = JSON.parse(run.decomposeJson) as DecomposeResult;
    } catch (err) {
      throw new Error(`corrupt decomposeJson: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      generate = JSON.parse(run.generateJson) as GenerateResult;
    } catch (err) {
      throw new Error(`corrupt generateJson: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      assemble = JSON.parse(run.assembleJson) as AssembleResult;
    } catch (err) {
      throw new Error(`corrupt assembleJson: ${err instanceof Error ? err.message : String(err)}`);
    }
    finalVideoR2Key = run.finalVideoR2Key;

    return {
      outputRefs: [
        {
          label: "summary",
          kind: "json",
          value: JSON.stringify({ shotCount: blueprint.shots.length, draftKey: finalVideoR2Key, passBudget: d.maxPasses }),
        },
      ],
    };
  });

  const workDir = path.join(tmpdir(), `ad-clone-judge-${ctx.runId}`);
  let result!: JudgeResult;

  try {
    await mkdir(workDir, { recursive: true });

    // ── Per-pass extraction + comparison + scoring ────────────────────────
    async function runPass(
      pass: number,
      draftKey: string,
      assembleResult: AssembleResult,
    ): Promise<PassOutcome> {
      let draftFrames: Array<{ index: number; frameR2Keys: string[]; midFrameR2Key: string }> = [];

      await d.withStepFn(ctx.runId, "judge", `Extract draft frames (pass ${pass})`, {}, async () => {
        const { buffer } = await d.getObjectBufferFn({ bucket: IMAGE_BUCKET, key: draftKey });
        const localVideoPath = path.join(workDir, `pass${pass}-draft.mp4`);
        await writeFile(localVideoPath, buffer);
        draftFrames = await d.extractFramesFn(
          { segments: assembleResult.segments, localVideoPath, workDir, runId: ctx.runId, pass },
          {},
        );
        const ranges = segmentTimeRanges(assembleResult.segments);
        return {
          outputRefs: [
            ...draftFrames.map(
              (f): StepArtifactRef => ({ label: `shot ${f.index} draft mid frame`, kind: "image", r2Key: f.midFrameR2Key }),
            ),
            { label: "ranges", kind: "json", value: JSON.stringify(ranges) },
          ],
        };
      });

      const draftFramesByIndex = new Map(draftFrames.map((f) => [f.index, f]));
      const shots: JudgeShotComparison[] = [];

      for (const segment of assembleResult.segments) {
        await d.withStepFn(ctx.runId, "judge", `Compare shot ${segment.index} (pass ${pass})`, {}, async () => {
          const originalShot = decompose.shots.find((s) => s.index === segment.index);
          if (!originalShot) throw new Error(`no decompose shot found for shot ${segment.index}`);
          const draft = draftFramesByIndex.get(segment.index);
          if (!draft) throw new Error(`no draft frames extracted for shot ${segment.index}`);
          const blueprintShot: BlueprintShot | undefined = blueprint.shots.find((s) => s.index === segment.index);
          if (!blueprintShot) throw new Error(`no blueprint shot found for shot ${segment.index}`);

          const overlay = decompose.overlays.find((o) => o.shotIndex === segment.index);
          const overlayContext: OverlayContext = {
            originalHasOverlay: !!overlay,
            originalPosition: overlay ? overlay.position : null,
            oursBurned: !!segment.overlayBurned,
          };

          const pair = await d.loadPairFn(originalShot.frameR2Keys, draft.frameR2Keys);
          const comparison = await d.compareFn({
            index: segment.index,
            kind: segment.kind,
            blueprintShot,
            original: pair.original,
            draft: pair.draft,
            originalDurationS: originalShot.durationS,
            draftDurationS: segment.targetDurationS,
            overlayContext,
            originalFrameR2Keys: originalShot.frameR2Keys,
            draftFrameR2Keys: draft.frameR2Keys,
          });
          shots.push(comparison);

          return {
            outputRefs: [
              { label: "original mid frame", kind: "image", r2Key: originalShot.midFrameR2Key },
              { label: "draft mid frame", kind: "image", r2Key: draft.midFrameR2Key },
              { label: "comparison", kind: "json", value: JSON.stringify(comparison) },
            ],
            prompt: comparison.prompt,
            response: comparison.response,
            costUsd: comparison.costUsd,
          };
        });
      }

      let converged = false;
      let convergenceScore = 0;
      let regenChosen: number[] = [];
      let fixHints: Record<number, string> = {};
      let droppedHints: number[] = [];
      let needsReassemble = false;

      await d.withStepFn(ctx.runId, "judge", `Score pass ${pass}`, {}, async () => {
        convergenceScore = scorePass(shots);
        converged = passConverged(shots);

        // Score-only on the FINAL pass: no pass N+1 exists to consume a
        // selection, so selection work is skipped entirely there.
        if (pass < d.maxPasses && !converged) {
          regenChosen = selectRegenerations(shots, REGEN_CAP);
          const built = buildFixHints(shots, regenChosen, blueprint.dontCopy);
          fixHints = built.hints;
          droppedHints = built.dropped;
          needsReassemble = needsReassembleOnly(shots, assembleResult.segments, blueprint, d.burnOverlays);

          // Stamp regenerate:true onto the chosen shots' comparison objects
          // BEFORE they're persisted into the JudgePass — compareShot always
          // returns regenerate:false by contract (policy is applied here,
          // after selectRegenerations picks the actual candidates).
          const chosenSet = new Set(regenChosen);
          for (const shot of shots) {
            if (chosenSet.has(shot.index)) shot.regenerate = true;
          }
        }

        return {
          outputRefs: [
            {
              label: "pass result",
              kind: "json",
              value: JSON.stringify({
                pass,
                convergenceScore,
                converged,
                verdicts: shots.map((s) => ({ index: s.index, kind: s.kind, verdict: s.verdict })),
                chosen: regenChosen,
                droppedHints,
                needsReassembleOnly: needsReassemble,
              }),
            },
          ],
        };
      });

      const costUsd = shots.reduce((sum, s) => sum + s.costUsd, 0);
      return { shots, convergenceScore, costUsd, converged, regenChosen, fixHints, droppedHints, needsReassemble };
    }

    // ── Bounded pass loop: 1..MAX_JUDGE_PASSES, refining between passes ────
    const passOutcomes: PassOutcome[] = [];
    const passDraftKeys: string[] = [];
    const passReassembled: boolean[] = [];
    const passRegeneratedIndices: number[][] = [];

    let currentDraftKey = finalVideoR2Key;
    let currentAssemble = assemble;

    for (let pass = 1; pass <= d.maxPasses; pass++) {
      const outcome = await runPass(pass, currentDraftKey, currentAssemble);
      passOutcomes.push(outcome);
      passDraftKeys.push(currentDraftKey);

      const wantsRefine =
        pass < d.maxPasses && !outcome.converged && (outcome.regenChosen.length > 0 || outcome.needsReassemble);

      if (!wantsRefine) {
        passReassembled.push(false);
        passRegeneratedIndices.push([]);
        break;
      }

      // Budget gate: refinement only proceeds while the run's cost so far
      // PLUS this refinement's projected cost stays under the ceiling.
      const currentRunCostUsd = await d.rollupRunCostFn(ctx.runId);
      // Findings 2/4: if one of the chosen shots is the run's talking shot,
      // it must be priced via the talking-aware O3 formula, not folded into
      // the plain silent-rate average — `avgDurationS` below is the OTHER
      // chosen shots' average only (score.ts's documented contract for
      // `projectedRefinementCostUsd`'s `avgShotDurationS` param when a
      // `talkingShotDecomposedDurationS` is also supplied).
      const talkingShot = findTalkingShot(outcome.regenChosen, blueprint);
      const talkingShotDecomposedDurationS = talkingShot
        ? (decompose.shots.find((s) => s.index === talkingShot.index)?.durationS ?? null)
        : null;
      const nonTalkingChosen = talkingShot ? outcome.regenChosen.filter((i) => i !== talkingShot.index) : outcome.regenChosen;
      const avgDurationS = avgChosenShotDurationS(nonTalkingChosen, decompose);
      const budget = refinementWithinBudget(
        currentRunCostUsd,
        outcome.regenChosen.length,
        avgDurationS,
        d.maxRunUsd,
        talkingShotDecomposedDurationS,
      );

      if (!budget.allowed) {
        await d.withStepFn(ctx.runId, "judge", "Refine diverged shots", {}, async () => ({
          outputRefs: [
            {
              label: "note",
              kind: "text",
              value: `refinement blocked - projected $${budget.projectedCostUsd.toFixed(2)} would bring the run to $${budget.wouldTotalUsd.toFixed(2)}, over the $${d.maxRunUsd.toFixed(2)} AD_CLONE_MAX_RUN_USD budget ceiling; pass ${pass} stands as final`,
            },
          ],
        }));
        passReassembled.push(false);
        passRegeneratedIndices.push([]);
        break;
      }

      // Bug 4/10 fix: one collision-free suffix, shared by this pass's
      // video AND card filenames — see nextPassArtifactSuffix's doc comment.
      const suffix = nextPassArtifactSuffix(passDraftKeys);
      const nextFilename = `final-${suffix}.mp4`;

      // Bug 5a fix: applyRefinement's (or the reassemble-only branch's)
      // FIRST durable action nulls BOTH finalVideoR2Key AND assembleJson
      // before any replacement render/assemble exists. Stash both pointers
      // for THIS pass's already-scored draft so a subsequent regen/assemble
      // failure can restore them together — a failed refinement then
      // degrades to "pass N stands as final" instead of leaving the run
      // with no video at all. Restoring finalVideoR2Key alone is not
      // enough: run-job.ts's isAssembleComplete requires assembleJson AND
      // finalVideoR2Key both non-null to skip the assemble stage on
      // resume, so a partial restore would still re-run assemble (and
      // generate, since the regen-chosen shot is still status:"failed")
      // on the very next resume attempt.
      const preRefinementDraftKey = currentDraftKey;
      const preRefinementAssembleJson = JSON.stringify(currentAssemble);
      try {
        await d.withStepFn(ctx.runId, "judge", "Refine diverged shots", {}, async () => {
          if (outcome.regenChosen.length > 0) {
            await applyRefinement(
              { runId: ctx.runId, generate, chosen: outcome.regenChosen, fixHints: outcome.fixHints },
              { updateRunFn: d.updateRunFn },
            );
            await d.runGenerateFn(ctx, { ...d.generateDeps, fixHints: outcome.fixHints });
          } else {
            // Reassemble-only shape (overlay burn-fix): applyRefinement is
            // never called (nothing was regenerated), so clear the assemble
            // gate ourselves before re-running assemble.
            await d.updateRunFn(ctx.runId, { assembleJson: null, finalVideoR2Key: null });
          }
          await d.runAssembleFn(ctx, { ...d.assembleDeps, finalFilename: nextFilename, cardFilenameSuffix: suffix });

          return {
            outputRefs:
              outcome.regenChosen.length > 0
                ? [
                    {
                      label: "fix hints",
                      kind: "json",
                      value: JSON.stringify({ hints: outcome.fixHints, dropped: outcome.droppedHints }),
                    },
                  ]
                : [{ label: "note", kind: "text", value: "re-assemble only - overlay burn fix" }],
          };
        });
      } catch (err) {
        await d.updateRunFn(ctx.runId, {
          finalVideoR2Key: preRefinementDraftKey,
          assembleJson: preRefinementAssembleJson,
        });
        throw err;
      }
      passReassembled.push(true);
      passRegeneratedIndices.push(outcome.regenChosen);

      const refreshed = await d.loadRunFn(ctx.runId);
      if (!refreshed || !refreshed.assembleJson || !refreshed.finalVideoR2Key) {
        throw new Error("judge refinement did not produce a new assemble result");
      }
      currentAssemble = JSON.parse(refreshed.assembleJson) as AssembleResult;
      currentDraftKey = refreshed.finalVideoR2Key;
      // Re-sync the in-memory generate result so a SECOND refinement round
      // (pass 2 -> pass 3) resets shots against the freshly-regenerated
      // state, not the stale pre-pass-1 snapshot — otherwise applyRefinement
      // would silently clobber pass 1's regenerated shot data back to its
      // old value for every shot NOT chosen again in pass 2.
      if (refreshed.generateJson) {
        generate = JSON.parse(refreshed.generateJson) as GenerateResult;
      }
    }

    // ── Final verdict: best of the passes, restoring the best pass's key ──
    await d.withStepFn(ctx.runId, "judge", "Final verdict", {}, async () => {
      const passes: JudgePass[] = passOutcomes.map((outcome, i) => ({
        pass: i + 1,
        draftVideoR2Key: passDraftKeys[i],
        shots: outcome.shots,
        convergenceScore: outcome.convergenceScore,
        regeneratedIndices: passRegeneratedIndices[i],
        reassembled: passReassembled[i],
        costUsd: outcome.costUsd,
      }));

      // argmax across ALL passes, tie -> the LATER pass (>=, not >).
      let bestIdx = 0;
      for (let i = 1; i < passes.length; i++) {
        if (passes[i].convergenceScore >= passes[bestIdx].convergenceScore) bestIdx = i;
      }
      const bestPass = passes[bestIdx].pass;
      const bestScore = passes[bestIdx].convergenceScore;
      const bestShots = passes[bestIdx].shots;
      const bestDraftKey = passes[bestIdx].draftVideoR2Key;

      const weaknesses = weaknessSummary(bestShots);
      const converged = passConverged(bestShots);
      const totalCostUsd = passes.reduce((sum, p) => sum + p.costUsd, 0);

      result = { passes, bestPass, converged, weaknesses, totalCostUsd };

      await d.updateRunFn(ctx.runId, {
        judgeJson: JSON.stringify(result),
        convergenceScore: bestScore,
        finalVideoR2Key: bestDraftKey,
      });

      const verdict =
        passes.length === 1
          ? `converged in 1 pass at ${bestScore}`
          : `returned best of ${passes.length} passes (pass ${bestPass}, ${bestScore}) - see weaknesses`;

      return {
        outputRefs: [
          { label: "best final video", kind: "video", r2Key: bestDraftKey },
          { label: "weaknesses", kind: "json", value: JSON.stringify(weaknesses) },
          { label: "verdict", kind: "text", value: verdict },
        ],
      };
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  return result;
}
