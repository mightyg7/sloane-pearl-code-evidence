// src/lib/angle-loop/brief.ts — the Angle Brief refresh job. Chained after
// each Creative Cockpit sync (see creative-cockpit/daily.ts). Two layers:
// deterministic stats + bounds (stats.ts / bounds.ts), then Sonnet ranks
// within those bounds and writes the human-readable rationale. Any LLM
// weight outside the bounds is clamped in code; on LLM failure nothing is
// written and the previous brief simply stays current.
import prisma from "@/lib/db";
import { createAnthropic } from "@/lib/anthropic-factory";
import { trackAnthropicUsage } from "@/lib/usage-tracker";
import { parseFirstJsonObject } from "@/lib/creative-cockpit/json";
import { computeAngleStats, mergeStoreWithPooled, type InsightStatRow } from "./stats";
import { computeCandidates, clampDecision, type AngleCandidate } from "./bounds";
import { EXPLORATION_FLOOR, type BriefDecision, type MergedAngleStat } from "./types";

const MODEL = "claude-sonnet-4-6";
const STATS_WINDOW_DAYS = 30;

export async function runAngleBriefRefresh(
  opts: { accountId?: string } = {},
): Promise<{ account: boolean; global: boolean }> {
  const accountId = opts.accountId ?? process.env.META_AD_ACCOUNT_ID ?? "";
  if (!accountId) throw new Error("runAngleBriefRefresh: accountId required");

  const since = new Date(Date.now() - STATS_WINDOW_DAYS * 86_400_000);
  const rows = (await prisma.adAssetInsight.findMany({
    where: { assetType: { in: ["body", "title"] }, date: { gte: since } },
    select: {
      accountId: true, assetKey: true, angleSlug: true, angleLabel: true,
      intendedAngleSlug: true, assetType: true, spend: true, impressions: true, linkClicks: true,
      purchases: true, purchaseValue: true,
    },
  })) as InsightStatRow[];

  const pooled = computeAngleStats(rows);
  const store = computeAngleStats(rows.filter((r) => r.accountId === accountId));

  const pooledMerged: MergedAngleStat[] = [...pooled.values()].map((s) => ({ ...s, source: "pooled" as const }));
  const global = await writeBrief(null, pooledMerged);
  const account = await writeBrief(accountId, mergeStoreWithPooled(store, pooled));
  return { account, global };
}

async function writeBrief(accountId: string | null, merged: MergedAngleStat[]): Promise<boolean> {
  const candidates = computeCandidates(merged);
  if (candidates.length === 0) return false;

  const decision = clampDecision(await generateBriefDecision(candidates), candidates);

  const latest = await prisma.angleBrief.findFirst({
    where: { accountId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const version = (latest?.version ?? 0) + 1;
  try {
    await prisma.$transaction([
      prisma.angleBrief.updateMany({
        where: { accountId, status: "current" },
        data: { status: "superseded" },
      }),
      prisma.angleBrief.create({
        data: {
          accountId, version, status: "current",
          weightsJson: JSON.stringify(decision.weights),
          avoidJson: JSON.stringify(decision.avoid),
          rationale: decision.rationale,
          statsJson: JSON.stringify(candidates),
          model: MODEL,
        },
      }),
    ]);
  } catch (e) {
    // Two concurrent refreshes can both compute the same next version off a
    // stale `latest` read — the unique constraint on (accountId, version)
    // catches the race. The other writer already won; skip quietly rather
    // than crash the whole refresh.
    if ((e as { code?: string })?.code === "P2002") {
      console.warn(`[angle-loop] brief v${version} for ${accountId ?? "GLOBAL"} lost a concurrent-write race — skipping (other writer won)`);
      return false;
    }
    throw e;
  }
  console.log(
    `[angle-loop] brief v${version} written for ${accountId ?? "GLOBAL"}: ` +
    `${decision.weights.length} weighted, ${decision.avoid.length} avoided`,
  );
  return true;
}

async function generateBriefDecision(candidates: AngleCandidate[]): Promise<BriefDecision> {
  const client = createAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY_ADS || process.env.ANTHROPIC_API_KEY, purpose: "angle-brief", ads: true,
  });
  const lines = candidates.map((c) =>
    `slug=${c.slug} | label=${c.label} | spend=€${c.spend.toFixed(0)} | linkCtr=${c.linkCtr.toFixed(2)}% | ` +
    `roas=${c.roas == null ? "n/a" : c.roas.toFixed(2)} | purchases=${c.purchases} | creatives=${c.creatives} | ` +
    `source=${c.source} | maxWeight=${c.maxWeight} | avoidEligible=${c.avoidEligible}`,
  ).join("\n");

  const prompt = `You are a performance-marketing analyst steering which ad ANGLES get generated for the next launches. Below are per-angle live results (source=store means this store's own confirmed data; source=pooled means the cross-store baseline).

Decide:
1. "weights" — which angles to bias NEW ad generation toward. Only use slugs from the list. Each weight must be <= that angle's maxWeight. The TOTAL of all weights must be <= ${(1 - EXPLORATION_FLOOR).toFixed(1)} (the remaining ${EXPLORATION_FLOOR} is reserved for exploration and is handled elsewhere). Give each weighted angle one short "guidance" sentence a copywriter can act on.
2. "avoid" — angles to stop generating. ONLY slugs where avoidEligible=true. Give each a one-sentence data-grounded reason.
3. "rationale" — max 80 words, plain English, explaining the overall read for an operator.

Return STRICT JSON only: {"weights":[{"slug":"...","weight":0.0,"guidance":"..."}],"avoid":[{"slug":"...","reason":"..."}],"rationale":"..."}

Angles:
${lines}`;

  const res: any = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });
  if (res?.usage) await trackAnthropicUsage({ usage: res.usage, model: MODEL, purpose: "angle-brief" });
  const text = res?.content?.[0]?.type === "text" ? res.content[0].text : "";
  const parsed = parseFirstJsonObject<{
    weights?: { slug: string; weight: number; guidance?: string }[];
    avoid?: { slug: string; reason?: string }[];
    rationale?: string;
  }>(text);
  return {
    weights: (parsed.weights ?? []).map((w) => ({
      slug: w.slug, label: "", weight: Number(w.weight) || 0,
      guidance: w.guidance ?? "", source: "pooled" as const,
    })),
    avoid: (parsed.avoid ?? []).map((a) => ({ slug: a.slug, label: "", reason: a.reason ?? "" })),
    rationale: parsed.rationale ?? "",
  };
}
