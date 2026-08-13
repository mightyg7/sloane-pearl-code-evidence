// src/lib/angle-loop/bounds.ts — deterministic layer around the LLM brief.
// Computes hard bounds from stats; clamps whatever the LLM returns so it can
// never zero-out exploration, over-weight thin data, or blacklist an angle
// the data doesn't condemn.
import {
  SPEND_CONFIRM_THRESHOLD,
  MIN_CONVERSIONS_CONFIRMED,
} from "@/lib/creative-cockpit/constants";
import {
  EXPLORATION_FLOOR,
  MAX_ANGLE_WEIGHT,
  type BriefDecision,
  type MergedAngleStat,
} from "./types";

/** An angle can only be avoided on confirmed bad data below this ROAS. */
const AVOID_ROAS_CEILING = 0.3;
/** Weight ceiling for angles without confirmed data. */
const UNCONFIRMED_MAX_WEIGHT = 0.15;

export interface AngleCandidate extends MergedAngleStat {
  maxWeight: number;
  avoidEligible: boolean;
  confirmed: boolean;
}

export function computeCandidates(merged: MergedAngleStat[]): AngleCandidate[] {
  return merged.map((m) => {
    const confirmed =
      m.spend >= SPEND_CONFIRM_THRESHOLD && m.purchases >= MIN_CONVERSIONS_CONFIRMED;
    const avoidEligible =
      m.spend >= SPEND_CONFIRM_THRESHOLD &&
      (m.purchases === 0 || (m.roas !== null && m.roas < AVOID_ROAS_CEILING));
    return {
      ...m,
      confirmed,
      avoidEligible,
      maxWeight: confirmed ? MAX_ANGLE_WEIGHT : UNCONFIRMED_MAX_WEIGHT,
    };
  });
}

export function clampDecision(
  decision: BriefDecision,
  candidates: AngleCandidate[],
): BriefDecision {
  const bySlug = new Map(candidates.map((c) => [c.slug, c]));

  const avoid = (decision.avoid ?? [])
    .filter((a) => bySlug.get(a.slug)?.avoidEligible)
    .map((a) => ({ ...a, label: bySlug.get(a.slug)!.label }));
  const avoided = new Set(avoid.map((a) => a.slug));

  let weights = (decision.weights ?? [])
    .filter((w) => bySlug.has(w.slug) && !avoided.has(w.slug))
    .map((w) => {
      const c = bySlug.get(w.slug)!;
      return {
        ...w,
        label: c.label,
        source: c.source,
        weight: Math.min(Math.max(w.weight, 0), c.maxWeight),
      };
    })
    .filter((w) => w.weight > 0);

  const cap = 1 - EXPLORATION_FLOOR;
  const total = weights.reduce((s, w) => s + w.weight, 0);
  if (total > cap) {
    const scale = cap / total;
    weights = weights.map((w) => ({ ...w, weight: w.weight * scale }));
  }

  return { weights, avoid, rationale: decision.rationale ?? "" };
}
