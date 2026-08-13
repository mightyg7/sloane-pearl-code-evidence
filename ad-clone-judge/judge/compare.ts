/** Per-shot side-by-side vision comparison for the ad-clone judge stage.
 *
 * ONE sonnet vision call per shot compares OUR generated ad-clone frames
 * against the original competitor ad's frames, and must stay BLIND to the
 * three deltas the pipeline *intends* to introduce: which garment is worn,
 * logo/brand-mark/overlay-text CONTENT, and audio. Judged dimensions map
 * 1:1 onto `JudgeDimension` (framing, motion, pose, composition, lighting,
 * pacing, overlay-layout, persona, artifact, style). `style` (Plan 6 Task 6)
 * is production register — amateur/UGC handheld vs polished editorial vs
 * cinematic — never a judgement on which garment is worn.
 *
 * Blindness is structural, not just a prompt instruction: `compareShot`'s
 * input surface never accepts the Blueprint's `dontCopy` strings (only a
 * `BlueprintShot` — which has no `dontCopy` field — plus already-loaded
 * `VisionImage[]` frames), so there is no code path for a poisoned overlay
 * text or brand-mark string to reach the prompt.
 *
 * `originalFrameR2Keys`/`draftFrameR2Keys` on the returned
 * `JudgeShotComparison` are echoed through from the input: the orchestrator
 * can pass them directly via `CompareShotInput` (optional), and they will be
 * mirrored onto the result. If omitted, they default to empty arrays.
 *
 * qcode vision-call rules: image blocks FIRST, then text, in ONE user
 * turn; NO tools; JSON-in-prompt; `{ timeout: 120_000 }` per request.
 */

import { z } from "zod";
import { createAnthropic } from "@/lib/anthropic-factory";
import { resolveKey } from "@/lib/api-keys-store";
import { trackAnthropicUsage, type AnthropicUsageLike } from "@/lib/usage-tracker";
import { estimateAnthropicCost } from "@/lib/anthropic-pricing";
import { SONNET_MODEL } from "@/lib/anthropic-client";
import { getObjectBuffer } from "@/lib/storage/r2";
import { IMAGE_BUCKET } from "@/lib/storage/save-image";
import { resizeVisionImage } from "@/lib/creative-scorer/media";
import type { VisionImage } from "@/lib/creative-scorer/anthropic";
import { extractJsonObject, repairUnescapedInnerQuotes } from "../strategize/validate";
import type { Blueprint, BlueprintShot } from "../strategize/types";
import type { JudgeDimension, JudgeDivergence, JudgeShotComparison } from "./types";

const PURPOSE = "ad-clone-judge";

// Bounded at 2 (not 3, unlike the strategize corrective-retry) — the judge
// call is much cheaper to get right the first time (fixed dimension list,
// fixed JSON shape), so a persistent failure after one corrective turn is
// treated as a hard stop rather than burning a third sonnet call.
export const MAX_COMPARE_ATTEMPTS = 2;

const KNOWN_DIMENSIONS: JudgeDimension[] = [
  "framing",
  "motion",
  "pose",
  "composition",
  "lighting",
  "pacing",
  "overlay-layout",
  "persona",
  "artifact",
  "style",
];
const KNOWN_DIMENSION_SET = new Set<string>(KNOWN_DIMENSIONS);
const VERDICTS = ["match", "minor", "diverged"] as const;

// --- Public types ------------------------------------------------------

export interface OverlayContext {
  originalHasOverlay: boolean;
  originalPosition: "top" | "center" | "bottom" | "unknown" | null;
  oursBurned: boolean;
}

export interface CompareShotInput {
  index: number;
  kind: "clip" | "card";
  blueprintShot: BlueprintShot;
  original: VisionImage[];
  draft: VisionImage[];
  originalDurationS: number;
  draftDurationS: number;
  overlayContext: OverlayContext;
  originalFrameR2Keys?: string[];
  draftFrameR2Keys?: string[];
  /** Plan 6 Task 3: "still" compares a single pre-video still (still-loop.ts)
   *  against the reference shot's own mid-frame — drops the pacing/motion/
   *  overlay-layout dimensions and the duration/motion-context language that
   *  don't apply before a shot has been animated or assembled. Omitted
   *  (every existing caller) defaults to "shot" — byte-identical prompt to
   *  before this flag existed. */
  mode?: "shot" | "still";
  /** F4 fix (Plan 6 pre-E2E wave): whole-ad visual register
   *  (Blueprint.styleRegister), threaded into "still" mode ONLY as a
   *  one-line judging note — "style" is already a judged dimension, but a
   *  still-loop compare had no register context to judge it against.
   *  Additive/optional: omitted, or present in "shot" mode, produces a
   *  BYTE-IDENTICAL prompt to before this field existed. */
  styleRegister?: Blueprint["styleRegister"];
}

/** Minimal Anthropic-shaped response — covers both the lane client and test fakes. */
interface CompareMessageResponse {
  content: Array<{ type: string; text?: string }>;
  usage?: unknown;
}

export interface CompareDeps {
  client?: {
    messages: {
      // Method shorthand (bivariant) so the real LaneMessagesClient — whose
      // create takes MessageCreateParamsNonStreaming — is assignable here.
      create(req: unknown, opts?: unknown): Promise<CompareMessageResponse>;
    };
  };
  resolveApiKey?: (keyName: string) => Promise<string | null | undefined>;
  track?: typeof trackAnthropicUsage;
}

export interface LoadFramePairDeps {
  getObject?: typeof getObjectBuffer;
  resize?: typeof resizeVisionImage;
}

// --- Frame loading -------------------------------------------------------

/**
 * Reads every original/draft frame R2 key into a resized `VisionImage`,
 * preserving array order. Throws naming the specific key that failed to
 * load (missing object, R2 error, etc.) — never a generic/opaque error.
 */
export async function loadShotFramePair(
  originalKeys: string[],
  draftKeys: string[],
  deps: LoadFramePairDeps = {},
): Promise<{ original: VisionImage[]; draft: VisionImage[] }> {
  const getObject = deps.getObject ?? getObjectBuffer;
  const resize = deps.resize ?? resizeVisionImage;

  async function loadOne(key: string): Promise<VisionImage> {
    let buffer: Buffer;
    let contentType: string | null;
    try {
      const obj = await getObject({ bucket: IMAGE_BUCKET, key });
      buffer = obj.buffer;
      contentType = obj.contentType;
    } catch (err) {
      throw new Error(
        `loadShotFramePair: failed to load frame "${key}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const img: VisionImage = { base64: buffer.toString("base64"), contentType: contentType ?? "image/jpeg" };
    return resize(img);
  }

  const original = await Promise.all(originalKeys.map(loadOne));
  const draft = await Promise.all(draftKeys.map(loadOne));
  return { original, draft };
}

// --- Prompt construction ---------------------------------------------------

/** One sentence describing overlay presence/position — NEVER wording. */
export function buildOverlaySentence(ctx: OverlayContext): string {
  const referencePhrase = ctx.originalHasOverlay
    ? `The reference shot carries an on-screen text overlay near the ${
        ctx.originalPosition && ctx.originalPosition !== "unknown" ? ctx.originalPosition : "unknown position"
      }`
    : "The reference shot carries no on-screen text overlay";
  const oursPhrase = ctx.oursBurned ? "ours does carry one" : "ours does not carry one";
  return `${referencePhrase}; ${oursPhrase} — judge overlay presence, position and layout, never its wording.`;
}

const GARMENT_BLINDNESS_CLAUSE =
  "Ignore WHICH GARMENT is worn: identity, colour, print, and fabric differences between the two shots are INTENDED, not a defect. Never penalize or even mention a different garment.";
const AUDIO_BLINDNESS_CLAUSE =
  "Ignore audio entirely: no voiceover, music, or lyrics were provided to you, and none should factor into your verdict. This is a silent, visual-only comparison.";

/** Shot mode WITH overlays actually burned onto our clip: layout is a fair
 *  thing to judge — only the wording is off-limits. */
const OVERLAY_BLINDNESS_CLAUSE_SHOT =
  "Ignore logo, brand-mark, and overlay-text CONTENT (the literal wording) differences entirely — but layout, position, size, and timing of any overlay or logo ARE judged.";

/**
 * Still mode: our still deliberately carries NO on-screen text — overlays are
 * composed at assembly, onto the finished clip. Excluding the "overlay-layout"
 * dimension is not enough on its own: run cms2v0yvs01cv1bnyxayjdh11 shows the
 * model filing the missing overlay under "composition"/"framing" instead and
 * emitting fixes like "Add a centered white rounded text-card overlay", which
 * still-loop appends to the next render's prompt. Blindness is the only lever
 * that binds across every dimension — same mechanism the garment swap uses.
 */
const OVERLAY_BLINDNESS_CLAUSE_STILL =
  "Ignore ON-SCREEN TEXT entirely, under any dimension: our still deliberately carries no overlay, caption, or text card (they are composed later, at assembly), so text present in the reference and absent from ours is INTENDED, not a defect. Never judge, penalize, mention, or propose re-adding it — not its wording, and not its presence, position, size or layout.";

/**
 * fix-ad-clone-collage-erro: shot mode WITHOUT overlays burned — same
 * BURN_BLUEPRINT_OVERLAYS-off doctrine as the still-mode clause above, but a
 * shot clip is the FINAL assembled output (no "composed later" step still to
 * come), so the wording says "in this run" rather than "at assembly".
 * `OVERLAY_BLINDNESS_CLAUSE_SHOT` above silently assumed burning was on;
 * with it off (current default, see BURN_BLUEPRINT_OVERLAYS), that clause
 * told the judge overlay layout "ARE judged" while every clip structurally
 * carries no overlay — an automatic, unclearable severity-3 hit on every
 * shot whose reference has on-screen text, dragging convergence down for a
 * deliberate design choice, not a defect.
 */
const OVERLAY_BLINDNESS_CLAUSE_SHOT_UNBURNED =
  "Ignore ON-SCREEN TEXT entirely, under any dimension: our clip deliberately carries no overlay, caption, or text card in this run, so text present in the reference and absent from ours is INTENDED, not a defect. Never judge, penalize, mention, or propose re-adding it — not its wording, and not its presence, position, size or layout.";

function blindnessClausesFor(mode: "shot" | "still", overlayBlind: boolean): string[] {
  const overlayClause =
    mode === "still" ? OVERLAY_BLINDNESS_CLAUSE_STILL : overlayBlind ? OVERLAY_BLINDNESS_CLAUSE_SHOT_UNBURNED : OVERLAY_BLINDNESS_CLAUSE_SHOT;
  return [GARMENT_BLINDNESS_CLAUSE, overlayClause, AUDIO_BLINDNESS_CLAUSE];
}

/** Every judgeable dimension's prompt line, keyed by its exact JudgeDimension
 *  string. STILL_MODE_EXCLUDED_DIMENSIONS names the ones ALWAYS dropped in
 *  "still" mode — a pre-video/pre-assembly still has no motion and no cut
 *  pacing, so judging those dimensions would only invite the model to fault
 *  us for something that hasn't happened yet. "overlay-layout" is dropped
 *  from EITHER mode whenever `overlayBlind` is true (still mode always;
 *  shot mode whenever this run doesn't burn overlays) — see
 *  `buildComparePrompt`'s dimension filter. */
const DIMENSION_LINES: Record<JudgeDimension, string> = {
  framing: `- "framing": shot framing / crop`,
  motion: `- "motion": camera move and motion feel`,
  pose: `- "pose": subject pose`,
  composition: `- "composition": composition / layout of the subject in frame`,
  lighting: `- "lighting": lighting and colour energy`,
  pacing: `- "pacing": pacing feel (cut timing, holds, energy of the cut)`,
  "overlay-layout": `- "overlay-layout": overlay layout — position, size, timing (never wording)`,
  persona: `- "persona": persona consistency (same look/energy as the rest of the ad)`,
  artifact: `- "artifact": visual artifacts or rendering glitches`,
  style: `- "style": production register — amateur/UGC handheld vs polished editorial vs cinematic`,
};
const STILL_MODE_EXCLUDED_DIMENSIONS = new Set<JudgeDimension>(["motion", "pacing"]);

/** "IMAGES 1-3 = REFERENCE shot, IMAGES 4-6 = OUR shot[. Each set is ...]" —
 *  parameterized by the ACTUAL frame counts on each side (Plan 6 Task 3).
 *  A count of 1 renders "IMAGE N" (singular); the "[start, mid, end]" /
 *  "N sequential" frame-list phrase is only appended when both sides carry
 *  the SAME count > 1 (mismatched counts skip that phrase rather than
 *  describe it inaccurately) and never in "still" mode (single-image sides
 *  have no frame list to describe at all). */
function buildImageIndexLine(originalCount: number, draftCount: number, mode: "shot" | "still"): string {
  const subjectLabel = mode === "still" ? "still" : "shot";
  const label = (count: number, startAt: number) => (count === 1 ? `IMAGE ${startAt}` : `IMAGES ${startAt}-${startAt + count - 1}`);
  const originalLabel = label(originalCount, 1);
  const draftLabel = label(draftCount, originalCount + 1);
  let line = `${originalLabel} = REFERENCE ${subjectLabel}, ${draftLabel} = OUR ${subjectLabel}.`;
  if (mode !== "still" && originalCount > 1 && originalCount === draftCount) {
    const framePhrase = originalCount === 3 ? "[start, mid, end]" : `${originalCount} sequential`;
    line += ` Each set is ${framePhrase} frames of that shot.`;
  }
  return line;
}

/** Pure text-block builder — no images. Exported for direct prompt testing. */
export function buildComparePrompt(input: {
  index: number;
  kind: "clip" | "card";
  blueprintShot: BlueprintShot;
  originalDurationS: number;
  draftDurationS: number;
  overlayContext: OverlayContext;
  originalCount: number;
  draftCount: number;
  mode?: "shot" | "still";
  /** F4 fix: see CompareShotInput.styleRegister — still-mode-only note. */
  styleRegister?: Blueprint["styleRegister"];
}): string {
  const { index, kind, blueprintShot, originalDurationS, draftDurationS, overlayContext, originalCount, draftCount } = input;
  const mode = input.mode ?? "shot";
  const isStill = mode === "still";
  const subjectLabel = isStill ? "still" : "shot";
  // fix-ad-clone-collage-erro: still mode never burns an overlay onto its
  // pre-video still; shot mode only burns one when this run's assembly
  // actually did (overlayContext.oursBurned, threaded from the real
  // BURN_BLUEPRINT_OVERLAYS-gated assemble output, not assumed true).
  const overlayBlind = isStill || !overlayContext.oursBurned;

  const dimensionLines = (Object.keys(DIMENSION_LINES) as JudgeDimension[])
    .filter((dim) => {
      if (isStill && STILL_MODE_EXCLUDED_DIMENSIONS.has(dim)) return false;
      if (dim === "overlay-layout" && overlayBlind) return false;
      return true;
    })
    .map((dim) => DIMENSION_LINES[dim])
    .join("\n");

  const contextParts = [`role="${blueprintShot.role}"`, `framing="${blueprintShot.framing}"`];
  if (!isStill) contextParts.push(`motion="${blueprintShot.motion}"`);
  const contextLine = `Context on what this shot was intended to do (for context only — not a checklist of things you must find fault with): ${contextParts.join(", ")}.`;

  const nonGarmentProps = isStill
    ? "LOCATION, SETTING, CAMERA FRAMING, and POSE"
    : "LOCATION, SETTING, CAMERA FRAMING, POSE, and MOTION";

  const registerLine =
    isStill && input.styleRegister
      ? `The ad's production register is ${input.styleRegister} - judge style accordingly.`
      : null;

  // Bug 7 fix: still-mode-only text-presence gate. The rendered still is
  // never supposed to carry any legible text/logo/typography (the doctrine
  // already mandates zero text in rendered stills) — competitor overlay
  // wording can otherwise leak through the composition-reference pixel
  // channel undetected, since BLINDNESS clause 2 above forbids judging
  // overlay/logo CONTENT. This is a presence check, not a wording judgement.
  const textPresenceLine = isStill
    ? `TEXT-PRESENCE CHECK — inspect ONLY OUR still (never the reference) for ANY legible text, logo, or typography anywhere in the frame: on-screen overlay, garment print, background signage, packaging, or watermark. Answer "ours_contains_text": "yes" or "no" in your JSON response — "yes" if there is any legible text, logo, or typography whatsoever, however small.`
    : null;

  const lines: Array<string | null> = [
    `You are comparing ${subjectLabel} ${index} (${kind}) of a fashion video ad-clone against the same ${subjectLabel} in the original reference ad.`,
    buildImageIndexLine(originalCount, draftCount, mode),
    ``,
    contextLine,
    registerLine,
    isStill ? null : `Reference shot duration: ${originalDurationS}s. Our shot duration: ${draftDurationS}s.`,
    overlayBlind ? null : buildOverlaySentence(overlayContext),
    ``,
    `GROUNDING — before judging, first describe in one sentence each what is visibly in the reference frames and in our frames: location, shot type, subject, and motion cues. Put these as "reference_summary" and "ours_summary" in your JSON response.`,
    textPresenceLine,
    ``,
    `BLINDNESS RULES — you MUST NOT judge, penalize, or mention any of these:`,
    ...blindnessClausesFor(mode, overlayBlind).map((c) => `- ${c}`),
    `The garment swap is intended and must be ignored — but ${nonGarmentProps} are not garment properties: judge them strictly even when the garment differs.`,
    `Blindness scope note: "style" is judged as production register only, never as a judgement on which garment is worn.`,
    ``,
    `Judge ONLY these dimensions (use these exact strings for "dimension" in your JSON):`,
    dimensionLines,
    ``,
    `For every dimension where the shots meaningfully diverge, emit one divergence with a severity using these anchors:`,
    `- severity 3 (structural): a different location or scene type (indoors vs outdoors, studio vs street), a different shot type (closeup vs full-body), a missing or extra person, static hold vs walking movement${overlayBlind ? "" : ", or an entirely absent overlay where the reference has one"}.`,
    `- a split-screen, multi-panel, or picture-in-picture layout in our frames where the reference is a single continuous full-frame shot is ALWAYS severity 3 "composition" - regardless of how similar the individual panels otherwise look.`,
    `- severity 2 (clear): same scene and shot type but clearly different camera distance, angle, background elements, or motion energy.`,
    `- severity 1 (subtle): subtle differences in tone, micro-pose, or grading.`,
    `style = production register: amateur/UGC handheld versus polished editorial versus cinematic. A register mismatch (reference is casual creator footage, ours is a polished brand film) is severity 3.`,
    `If the shots are equivalent on a dimension, omit it.`,
    `CARD SANITY: if our frames contain only a text/logo card while the reference shows footage, or vice versa, that is automatically a severity-3 "composition" divergence — say so explicitly.`,
    ``,
    `Then give an overall "verdict": "match" (no meaningful divergence), "minor" (only severity 1-2 divergences), or "diverged" (any severity-3 divergence, or many severity-2s).`,
    ``,
    `Return ONLY valid JSON, no prose, no markdown fences, in this exact shape:`,
    isStill
      ? `{"reference_summary":"one sentence describing the reference frames","ours_summary":"one sentence describing our frames","ours_contains_text":"no","divergences":[{"dimension":"framing","severity":2,"description":"how the reference and ours differ on this dimension","fix":"a shot-attributed instruction for regenerating this shot"}],"verdict":"minor"}`
      : `{"reference_summary":"one sentence describing the reference frames","ours_summary":"one sentence describing our frames","divergences":[{"dimension":"framing","severity":2,"description":"how the reference and ours differ on this dimension","fix":"a shot-attributed instruction for regenerating this shot"}],"verdict":"minor"}`,
    isStill
      ? `If there are no divergences: {"reference_summary":"...","ours_summary":"...","ours_contains_text":"no","divergences":[],"verdict":"match"}`
      : `If there are no divergences: {"reference_summary":"...","ours_summary":"...","divergences":[],"verdict":"match"}`,
  ];

  return lines.filter((l): l is string => l !== null).join("\n");
}

// --- Response parsing + enforcement ----------------------------------------

const RawDivergenceSchema = z.object({
  dimension: z.string(),
  // Not constrained to 1-3 here — out-of-range severities are a code-level
  // ENFORCEMENT concern (clamped below), not a validation failure that
  // should burn a corrective-retry attempt.
  severity: z.number(),
  description: z.string().min(1),
  fix: z.string().min(1),
});

const RawComparisonSchema = z.object({
  // Grounding fields (optional, backward compatible with pre-calibration
  // responses): one sentence each describing what's visibly in the
  // reference and our frames. Never promoted onto `JudgeShotComparison` —
  // they ride the persisted `response` raw text instead.
  reference_summary: z.string().optional(),
  ours_summary: z.string().optional(),
  // Bug 7 fix: still-mode-only text-presence gate. Optional/back-compat —
  // omitted on every "shot"-mode response (never asked) and on any
  // still-mode response predating this field; enforceComparison only acts
  // on it when mode === "still".
  ours_contains_text: z.enum(["yes", "no"]).optional(),
  divergences: z.array(RawDivergenceSchema),
  verdict: z.enum(VERDICTS),
});

type RawComparison = z.infer<typeof RawComparisonSchema>;

// fix-ad-clone-collage-erro: every string-valued key in RawComparisonSchema —
// free text (reference_summary/ours_summary/description/fix) is where the
// model has been observed to break JSON by quoting reference overlay copy
// with plain double-quotes; the short enum-like fields (dimension, verdict,
// ours_contains_text) are included too since they cost nothing extra and
// correctly bound the scan windows around their neighbors.
const COMPARISON_STRING_KEYS = [
  "reference_summary",
  "ours_summary",
  "ours_contains_text",
  "dimension",
  "description",
  "fix",
  "verdict",
];

// Matches V8's message for exactly the failure mode repairUnescapedInnerQuotes
// targets: a string value that closed early on a stray inner quote, leaving
// non-delimiter content where a `,` or `}` was expected next.
const UNESCAPED_QUOTE_ERROR = /Expected ',' or '}' after property value in JSON/;

export function parseComparisonJson(raw: string): RawComparison {
  const jsonText = extractJsonObject(raw);
  try {
    return RawComparisonSchema.parse(JSON.parse(jsonText));
  } catch (err) {
    const isJsonSyntaxError = err instanceof SyntaxError && UNESCAPED_QUOTE_ERROR.test(err.message);
    if (!isJsonSyntaxError) throw err;
    const repaired = repairUnescapedInnerQuotes(jsonText, COMPARISON_STRING_KEYS);
    if (repaired === jsonText) throw err; // nothing to repair — surface the original error
    return RawComparisonSchema.parse(JSON.parse(repaired));
  }
}

/**
 * Post-parse enforcement in CODE (not the model): unknown dimensions are
 * dropped, severity is clamped to the integer range 1-3, and the verdict
 * is coerced to "diverged" whenever any (post-clamp) severity-3 divergence
 * survives, OR when 2+ severity-2 divergences in NON-"overlay-layout"
 * dimensions survive — regardless of what the model itself claimed as the
 * verdict. The severity-2 escalation exists because the judge only ever
 * regenerates a clip on verdict "diverged": without it, two-plus clearly-
 * wrong dimensions (wrong camera distance AND wrong background, say) could
 * sit under "minor" forever and never trigger regeneration.
 *
 * Bug 7 fix: in "still" mode only, a model-reported `ours_contains_text ===
 * "yes"` is coerced in the same way — a synthetic severity-3 divergence is
 * appended (dimension "composition", never "overlay-layout" so it is never
 * excluded from the still-loop's best-of severity sum or its retry fix
 * text) carrying a targeted "remove all text/logos/typography" fix, which
 * forces the verdict to "diverged" via the existing hasSeverity3 rule
 * below. This is a PRESENCE gate, not a wording judgement — scoring
 * blindness to overlay/logo/text CONTENT (BLINDNESS clause 2 above) is
 * untouched. `mode` defaults to "shot" so every pre-existing caller is
 * unaffected.
 *
 * Round-1 review fix (Finding 1): the synthetic divergence above still
 * folds additively into `severitySum`, which the still-loop's best-of
 * selection compares with strict `<` — a later, text-free attempt that
 * ties a text-leaking attempt's severitySum on an UNRELATED divergence
 * loses the tie (earliest wins) and the leaking still ships. `hasTextLeak`
 * is returned as a first-class boolean alongside `divergences`/`verdict` so
 * callers (the still-loop) can gate best-of selection on text presence
 * BEFORE falling back to severitySum, independent of how severity happens
 * to sum up.
 */
export function enforceComparison(
  raw: RawComparison,
  mode: "shot" | "still" = "shot",
): { divergences: JudgeDivergence[]; verdict: "match" | "minor" | "diverged"; hasTextLeak: boolean } {
  const divergences: JudgeDivergence[] = [];
  for (const d of raw.divergences) {
    if (!KNOWN_DIMENSION_SET.has(d.dimension)) continue;
    const severity = Math.min(3, Math.max(1, Math.round(d.severity))) as 1 | 2 | 3;
    divergences.push({
      dimension: d.dimension as JudgeDimension,
      severity,
      description: d.description,
      fix: d.fix,
    });
  }
  const hasTextLeak = mode === "still" && raw.ours_contains_text === "yes";
  if (hasTextLeak) {
    divergences.push({
      dimension: "composition",
      severity: 3,
      description: "Our still contains legible text, a logo, or typography baked into the image.",
      fix: "Remove all text, logos, and typography from the still — the image must be completely clean of any lettering, wordmark, or brand mark.",
    });
  }
  const hasSeverity3 = divergences.some((d) => d.severity === 3);
  const nonOverlaySeverity2Count = divergences.filter(
    (d) => d.severity === 2 && d.dimension !== "overlay-layout",
  ).length;
  const verdict = hasSeverity3 || nonOverlaySeverity2Count >= 2 ? "diverged" : raw.verdict;
  return { divergences, verdict, hasTextLeak };
}

// --- Message-turn plumbing --------------------------------------------------

type ImageContentBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};
type TextContentBlock = { type: "text"; text: string };
type ContentBlock = ImageContentBlock | TextContentBlock;

interface MessageTurn {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

function toImageBlock(img: VisionImage): ImageContentBlock {
  return { type: "image", source: { type: "base64", media_type: img.contentType, data: img.base64 } };
}

// --- compareShot -------------------------------------------------------------

/**
 * Compares one shot's original vs draft frames via a sonnet vision call,
 * retrying up to MAX_COMPARE_ATTEMPTS times with a corrective turn that
 * quotes the exact validation error back to the model (mirrors
 * `writeBlueprint`'s corrective-retry loop, just with a lower cap).
 *
 * Key resolution: tries ANTHROPIC_API_KEY_ADS first; if null, console.warns
 * once and tries ANTHROPIC_API_KEY; if both null, throws.
 */
export async function compareShot(
  input: CompareShotInput,
  deps: CompareDeps = {},
): Promise<JudgeShotComparison & { prompt: string; response: string }> {
  const {
    index,
    kind,
    blueprintShot,
    original,
    draft,
    originalDurationS,
    draftDurationS,
    overlayContext,
    originalFrameR2Keys = [],
    draftFrameR2Keys = [],
    mode = "shot",
    styleRegister,
  } = input;

  const resolve = deps.resolveApiKey ?? resolveKey;
  let apiKey = await resolve("ANTHROPIC_API_KEY_ADS");
  if (!apiKey) {
    console.warn("[ad-clone-judge] ANTHROPIC_API_KEY_ADS not available; falling back to ANTHROPIC_API_KEY");
    apiKey = await resolve("ANTHROPIC_API_KEY");
  }
  if (!apiKey) {
    throw new Error("no Anthropic API key available for ad-clone judge");
  }

  const client: NonNullable<CompareDeps["client"]> =
    deps.client ?? createAnthropic({ apiKey, purpose: PURPOSE, ads: true });
  const track = deps.track ?? trackAnthropicUsage;

  const userText = buildComparePrompt({
    index,
    kind,
    blueprintShot,
    originalDurationS,
    draftDurationS,
    overlayContext,
    originalCount: original.length,
    draftCount: draft.length,
    mode,
    styleRegister,
  });

  // Image blocks FIRST (qcode rule): original's frames, then draft's frames,
  // then the text block — seeded as ONE user turn.
  const imageBlocks: ImageContentBlock[] = [...original.map(toImageBlock), ...draft.map(toImageBlock)];
  const firstTurnContent: ContentBlock[] = [...imageBlocks, { type: "text", text: userText }];
  const messages: MessageTurn[] = [{ role: "user", content: firstTurnContent }];

  let totalCostUsd = 0;
  let lastRawText = "";
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_COMPARE_ATTEMPTS; attempt++) {
    const res = await client.messages.create(
      { model: SONNET_MODEL, max_tokens: 2000, temperature: 0, messages },
      { timeout: 120_000 },
    );

    const text = res.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
    lastRawText = text;

    // Cost tracking: try/catch'd so it never fails the stage.
    try {
      const usage = res.usage as AnthropicUsageLike | null | undefined;
      totalCostUsd += estimateAnthropicCost(usage?.input_tokens ?? 0, usage?.output_tokens ?? 0, SONNET_MODEL);
      await track({ usage, model: SONNET_MODEL, purpose: PURPOSE });
    } catch {
      /* usage tracking must never fail the stage */
    }

    try {
      const raw = parseComparisonJson(text);
      const enforced = enforceComparison(raw, mode);
      return {
        index,
        kind,
        originalFrameR2Keys,
        draftFrameR2Keys,
        divergences: enforced.divergences,
        verdict: enforced.verdict,
        hasTextLeak: enforced.hasTextLeak,
        regenerate: false,
        costUsd: totalCostUsd,
        prompt: userText,
        response: text,
      };
    } catch (err) {
      lastError = err;
      if (attempt === MAX_COMPARE_ATTEMPTS) break;
      const errMsg = err instanceof Error ? err.message : String(err);
      // Feed the failed output + validator error back as a corrective turn.
      messages.push({ role: "assistant", content: text });
      messages.push({
        role: "user",
        content: [
          `Your previous output failed validation: ${errMsg}`,
          "",
          "Re-emit the COMPLETE corrected JSON with this issue fixed. Output ONLY the JSON — no preamble, no markdown fences, no commentary.",
        ].join("\n"),
      });
    }
  }

  const finalMsg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `compareShot: comparison for shot ${index} failed after ${MAX_COMPARE_ATTEMPTS} attempts. Last error: ${finalMsg}. Last raw output (first 400 chars): ${lastRawText.slice(0, 400)}`,
  );
}
