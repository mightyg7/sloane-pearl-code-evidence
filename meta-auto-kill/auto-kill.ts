/**
 * Meta Ads — Auto-Kill Engine.
 *
 * Checks active campaigns and pauses them if they cross spend thresholds
 * without meeting performance benchmarks.
 *
 * Rules (evaluated in strict order — first match wins):
 *   1. Purchases > 0                       → alive (sale = total immunity)
 *   2. CPC gate (one-shot, until cpcCheckDone is set):
 *        a. ATC > 0 (any spend level)     → retire CPC, alive
 *        b. spend ≥ $10:
 *             CPC > $1 (configurable)    → KILL (cpc)
 *             CPC ≤ $1                   → retire CPC, alive
 *   3. ATC = 0 AND spend ≥ $22            → KILL (atc)
 *   4. Purchases = 0 AND spend ≥ $37      → KILL (sale)
 *   5. Collection: Purchases = 0 AND spend ≥ $60 → KILL (collection_sale)
 *
 * Truth table (a = ATC, p = purchases, d = cpcCheckDone-after):
 *   p>0, any                     → alive               (rule 1)
 *   p=0, a>0, d=false            → alive, d:=true      (rule 2a)
 *   p=0, a>0, d=true             → fall to rules 3-5
 *   p=0, a=0, d=false, s<$10     → alive               (no checkpoint yet)
 *   p=0, a=0, d=false, s≥$10,    → KILL cpc OR retire  (rule 2b)
 *   p=0, a=0, d=true             → fall to rules 3-5
 *
 * Notes:
 *   - A sale logically implies an ATC (you can't buy without adding
 *     to cart), so the case p>0, a=0 is real-world impossible. Rule 1
 *     handles it gracefully anyway.
 *   - cpcCheckDone is persistent across ticks; once set, CPC is never
 *     re-evaluated for that campaign.
 *   - cpcSpendMin in settings is DEPRECATED — the $10 checkpoint is
 *     fixed (CPC_CHECKPOINT_SPEND). The field is kept in the schema
 *     for backward compat but no longer drives evaluation.
 *
 * All thresholds are USD. Meta reports spend in the ad account's native
 * currency — we convert to USD via `convertSpendToUsd` before evaluation.
 *
 * Signal sources:
 *   - ATC: Shopify ShopifyQL `sessions_with_cart_additions` scoped to
 *     the campaign's landing page (via `countShopifyAtcsForCampaigns`).
 *     Same metric Shopify admin shows as "Added to cart". No Meta
 *     Pixel fallback — if ShopifyQL can't resolve the campaign's
 *     landing path, the ATC rule is SKIPPED for that campaign rather
 *     than killing on an incorrect number.
 *   - Purchases (product): Shopify first-party orders (DB read via
 *     `countShopifyOrders`).
 *   - Purchases (collection): Shopify first-party orders, intersected
 *     with the campaign's collection product set
 *     (`countShopifyOrdersForCollectionCampaigns`). One paginated Admin
 *     GraphQL stream per store per tick. Bypasses our local Order DB
 *     because the orders/create webhook sync currently has gaps; flip
 *     to a DB read once that's reliable.
 *   - CPC: Meta's native `cost_per_inline_link_click` (CPC per link
 *     click), converted to USD.
 *
 * Naming: the rule is stored as `atc` in settings and logs for backward
 * compat; the label the operator sees is "ATC" (true Shopify add-to-cart).
 */

import prisma from "@/lib/db";
import { sha1 } from "@/lib/creative-cockpit/extract";
import type { AngleAttribution } from "@/lib/angle-loop/types";
import { graphPost, invalidateCache } from "./client";
import { listAdSets } from "./campaigns";
import { fetchInsights, parseActions } from "./insights";
import { notifyCampaignKilled } from "./slack";
import { getWarmupScaleFactor } from "./warmup";
import {
  ABO_KILL_DEFAULTS,
  evaluateAboAdSet,
  type AboAdSetStats,
  type AboKillRules,
} from "./abo-kill";
import {
  BUDGET_KILL_DEFAULTS,
  USD_RATES,
  resolveKillStrategyMode,
  evaluateBudgetSaleKill,
} from "./kill-strategy";
import {
  clearAttributionCache,
  countShopifyAtcsForCampaigns,
  countShopifyOrders,
  countShopifyOrdersForCollectionCampaigns,
  resolveConnectedStoreIdForAccount,
  resolveShopifyProductIdFromPath,
  resolveStoreForAccount,
} from "./shopify-attribution";

export function convertSpendToUsd(amount: number, fromCurrency: string | undefined): number {
  if (!fromCurrency) return amount; // assume already USD if Meta didn't say
  const upper = fromCurrency.toUpperCase();
  const rate = USD_RATES[upper];
  if (rate === undefined) {
    throw new Error(
      `convertSpendToUsd: unknown currency '${upper}' — refusing to default to 1.0. ` +
      `Add a USD rate for ${upper} to USD_RATES, or disable auto-kill for this account.`,
    );
  }
  return amount * rate;
}

/* ─── Kill Rules ─── */

/**
 * Fixed checkpoint at which the one-shot CPC gate fires. Replaces
 * the old configurable `cpcSpendMin`. Operators tuned this between
 * $10 and $25 historically with no measurable improvement, so we
 * pinned it at $10 — early enough to kill before runaway CPCs, late
 * enough to dodge first-impression noise.
 */
export const CPC_CHECKPOINT_SPEND = 10;

export interface KillRules extends AboKillRules {
  masterEnabled: boolean;
  cpcEnabled: boolean;
  atcEnabled: boolean;
  saleEnabled: boolean;
  collectionSaleEnabled: boolean;
  cpcThreshold: number;      // default $1 — CPC ceiling evaluated at the $10 checkpoint
  /** Spend checkpoint where the CPC gate fires (the `s ≥ X` in step 2b).
   *  Default $10 — see `CPC_CHECKPOINT_SPEND` for the fallback constant.
   *  Operator-editable from the auto-kill UI. */
  cpcSpendMin: number;
  atcSpendMin: number;       // default $22
  saleSpendMin: number;      // default $37
  collectionSpendMin: number; // default $60
  /** Budget-scaled sale-only mode (high-budget launches). See kill-strategy.ts. */
  budgetScaledSaleEnabled: boolean; // default true
  highBudgetUsd: number;            // default 86 (~€80) — cutoff to enter the mode
  saleBudgetRatio: number;          // default 0.48 — checkpoint = ratio × budget
  lastChecked?: string;
}

/**
 * All spend thresholds below are expressed in USD. Meta reports spend
 * in the ad account's native currency, so we convert native → USD at
 * evaluation time (see `convertSpendToUsd` below). UI should label
 * every input with "$" so operators aren't confused.
 */
const DEFAULT_RULES: KillRules = {
  ...ABO_KILL_DEFAULTS,
  masterEnabled: true,
  cpcEnabled: true,
  atcEnabled: true,
  saleEnabled: true,
  collectionSaleEnabled: true,
  cpcThreshold: 1,     // $1 CPC ceiling
  cpcSpendMin: 10,     // CPC checkpoint default — matches CPC_CHECKPOINT_SPEND
  atcSpendMin: 22,     // $22 spend checkpoint for ATC rule
  saleSpendMin: 37,    // $37 spend checkpoint for Sale rule
  collectionSpendMin: 60, // $60 spend checkpoint for collection Sale rule
  budgetScaledSaleEnabled: BUDGET_KILL_DEFAULTS.budgetScaledSaleEnabled,
  highBudgetUsd: BUDGET_KILL_DEFAULTS.highBudgetUsd,
  saleBudgetRatio: BUDGET_KILL_DEFAULTS.saleBudgetRatio,
};

export async function getKillRules(): Promise<KillRules> {
  const row = await prisma.metaAutoKillSettings.findUnique({ where: { key: "killRules" } });
  if (!row) return DEFAULT_RULES;
  return { ...DEFAULT_RULES, ...JSON.parse(row.value) };
}

export async function saveKillRules(rules: Partial<KillRules>): Promise<KillRules> {
  const current = await getKillRules();
  const updated = { ...current, ...rules };
  await prisma.metaAutoKillSettings.upsert({
    where: { key: "killRules" },
    update: { value: JSON.stringify(updated) },
    create: { key: "killRules", value: JSON.stringify(updated) },
  });
  return updated;
}

export async function toggleRule(rule: string, enabled: boolean): Promise<KillRules> {
  // Convert snake_case rule names to camelCase key (e.g. "collection_sale" → "collectionSaleEnabled")
  const camelRule = rule.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const key = `${camelRule}Enabled` as keyof KillRules;
  return saveKillRules({ [key]: enabled } as any);
}

export async function toggleMaster(enabled: boolean): Promise<KillRules> {
  return saveKillRules({ masterEnabled: enabled });
}

/* ─── Campaign Registration ─── */

export async function registerCampaignLaunch(params: {
  campaignId: string;
  accountId: string;
  campaignName: string;
  productPath?: string;
  launchDate: string;
  launchInstant?: Date;
  /// Meta's actual `start_time` — caller fetches this from the Graph
  /// API right after creation. Drives the auto-kill scan window.
  /// Optional only because some legacy callers (manual backfill) may
  /// not have it; the engine then falls back to launchDate.
  metaStartTime?: Date;
  campaignType?: "product" | "collection";
  /** Explicit auto-scale enrollment. MetaCampaignLaunch.autoScaleEnabled
   *  defaults to true in the schema, and runAutoScale selects on it — so
   *  ABO (validation-only) launches MUST pass `false` to stay out of the
   *  scaler. Omit (undefined) to keep the schema default for CBO launches. */
  autoScaleEnabled?: boolean;
  /** Budget structure. "abo" routes this campaign to the per-ad-set rules
   *  in abo-kill.ts instead of the campaign-level cascade. Omit for CBO. */
  budgetType?: "cbo" | "abo";
  /** Explicit auto-kill enrollment. MetaCampaignLaunch.autoKillEnabled
   *  defaults to true in the schema and the engine skips a launch when it
   *  is false — so ABO launches pass `false` (see abo.ts for why). Omit
   *  (undefined) to keep the schema default for CBO launches. */
  autoKillEnabled?: boolean;
  /** Operator-set daily budget (native currency) for the campaign.
   *  Drives the budget-scaled sale-only kill mode. */
  dailyBudget?: number;
  /** Angle Loop + copy engine: final body/headline texts attributed to the
   *  angle and/or CopyFunction they were generated from. Persisted as
   *  angleMapJson, keyed by `${assetType}:${sha1(text)}` (C15) so the
   *  cockpit sync can fill AdAssetInsight.intendedAngleSlug/fnSlug/
   *  fnVersion without a body/title text collision silently overwriting
   *  the wrong row. */
  angleAttribution?: AngleAttribution[];
}) {
  // Type MUST match the URL pattern — the kill engine and the simulator
  // route to different rules + attribution flows based on `campaignType`,
  // and a /products/X path can't resolve as a collection (and vice
  // versa). Override callers when their URL contradicts the type they
  // passed: it's a launcher-side bug we've seen in practice (pipeline
  // launches defaulting to "collection" while pointing at /products/X).
  const resolvedType = resolveCampaignTypeFromPath(params.productPath, params.campaignType);

  // Angle Loop + copy engine: build the angle map + register taxonomy
  // slugs. Fail-open — a taxonomy hiccup must never fail a launch
  // registration.
  //
  // C15: keyed by `${assetType}:${sha1(text)}`, NOT bare sha1(text). Two
  // different fields can legitimately emit identical text (a "Free
  // returns" description and headline; or the banned-name sweep
  // collapsing both to the brand name) — keying on text alone let one
  // silently overwrite the other's row, handing a headline's entire spend
  // to a function that never wrote a headline (an earlier task's test was
  // vacuous for exactly this reason: its headline and description
  // fixtures both emitted "T", so the headline assertion silently matched
  // the description's row). `field: "headline"` maps to AdAssetInsight's
  // "title" assetType; `field: "primary"` — and the missing case, for
  // pre-engine / legacy-Angle-Loop callers that never set `field` — maps
  // to "body". `field: "description"` is skipped entirely: AdAssetInsight
  // has no "description" assetType, so a description can never join
  // spend; including it only adds collision risk.
  //
  // Readers MUST build the identical key (see
  // src/lib/creative-cockpit/sync.ts) — a mismatched format means every
  // row silently fails to join while the sync looks healthy.
  let angleMapJson: string | undefined;
  if (params.angleAttribution && params.angleAttribution.length > 0) {
    const map: Record<
      string,
      { slug?: string; label?: string; fnSlug?: string; fnVersion?: number }
    > = {};
    for (const a of params.angleAttribution) {
      // An entry must contribute an Angle Loop slug OR a copy-engine
      // fnSlug to be worth persisting — bare text with neither is noise.
      if (!a.text || (!a.slug && !a.fnSlug)) continue;
      if (a.field === "description") continue;
      const assetType = a.field === "headline" ? "title" : "body";
      const key = `${assetType}:${sha1(a.text)}`;
      map[key] = {
        ...(a.slug ? { slug: a.slug, label: a.label } : {}),
        ...(a.fnSlug ? { fnSlug: a.fnSlug } : {}),
        ...(a.fnVersion !== undefined ? { fnVersion: a.fnVersion } : {}),
      };
    }
    if (Object.keys(map).length > 0) angleMapJson = JSON.stringify(map);
    try {
      const seen = new Set<string>();
      for (const a of params.angleAttribution) {
        if (!a.slug || seen.has(a.slug)) continue;
        seen.add(a.slug);
        await prisma.angleTaxonomy.upsert({
          where: { slug: a.slug },
          create: { slug: a.slug, label: a.label || a.slug },
          update: {},
        });
      }
    } catch (err) {
      console.warn(`[angle-loop] taxonomy upsert failed (non-fatal): ${(err as Error).message}`);
    }
  }

  await prisma.metaCampaignLaunch.upsert({
    where: { campaignId: params.campaignId },
    update: {
      campaignName: params.campaignName,
      productPath: params.productPath,
      launchDate: params.launchDate,
      launchInstant: params.launchInstant ?? null,
      metaStartTime: params.metaStartTime ?? null,
      campaignType: resolvedType,
      ...(params.autoScaleEnabled !== undefined ? { autoScaleEnabled: params.autoScaleEnabled } : {}),
      ...(params.autoKillEnabled !== undefined ? { autoKillEnabled: params.autoKillEnabled } : {}),
      ...(params.budgetType !== undefined ? { budgetType: params.budgetType } : {}),
      ...(params.dailyBudget !== undefined ? { launchDailyBudget: params.dailyBudget } : {}),
      ...(angleMapJson !== undefined ? { angleMapJson } : {}),
    },
    create: {
      campaignId: params.campaignId,
      accountId: params.accountId,
      campaignName: params.campaignName,
      productPath: params.productPath || null,
      launchDate: params.launchDate,
      launchInstant: params.launchInstant ?? null,
      metaStartTime: params.metaStartTime ?? null,
      campaignType: resolvedType,
      ...(params.autoScaleEnabled !== undefined ? { autoScaleEnabled: params.autoScaleEnabled } : {}),
      ...(params.autoKillEnabled !== undefined ? { autoKillEnabled: params.autoKillEnabled } : {}),
      ...(params.budgetType !== undefined ? { budgetType: params.budgetType } : {}),
      ...(params.dailyBudget !== undefined ? { launchDailyBudget: params.dailyBudget } : {}),
      ...(angleMapJson !== undefined ? { angleMapJson } : {}),
    },
  });
}

/**
 * Choose campaignType based on the URL pattern, falling back to the
 * caller's request when the path doesn't unambiguously identify a
 * type. The kill engine reads `campaignType` to pick its rule set
 * AND its attribution flow, so a mismatch between path and type
 * silently breaks attribution.
 */
function resolveCampaignTypeFromPath(
  productPath: string | undefined,
  requested: "product" | "collection" | undefined,
): "product" | "collection" {
  if (productPath) {
    if (/\/products\//i.test(productPath)) return "product";
    if (/\/collections\//i.test(productPath)) return "collection";
  }
  return requested ?? "product";
}

/* ─── Auto-Kill Engine ─── */

export interface AutoKillResult {
  checked: number;
  killed: number;
  skipped: number;
  recovered: number;
  details: { campaignId: string; campaignName: string; action: string; reason: string }[];
}

interface SnapshotInput {
  outcome: "killed" | "pass" | "skip";
  skipReason?: string | null;
  killRule?: string | null;
  spend?: number | null;
  spendNative?: number | null;
  currency?: string | null;
  linkClicks?: number | null;
  cpc?: number | null;
  atc?: number | null;
  purchases?: number | null;
  thresholdDesc?: string | null;
  strategyMode?: string | null;
}

async function persistSnapshot(
  launch: { campaignId: string; campaignName: string; accountId: string; campaignType: string },
  s: SnapshotInput,
): Promise<void> {
  try {
    await prisma.metaAutoKillSnapshot.create({
      data: {
        campaignId: launch.campaignId,
        campaignName: launch.campaignName,
        accountId: launch.accountId,
        campaignType: launch.campaignType,
        outcome: s.outcome,
        skipReason: s.skipReason ?? null,
        killRule: s.killRule ?? null,
        spend: s.spend ?? null,
        spendNative: s.spendNative ?? null,
        currency: s.currency ?? null,
        linkClicks: s.linkClicks ?? null,
        cpc: s.cpc ?? null,
        atc: s.atc ?? null,
        purchases: s.purchases ?? null,
        thresholdDesc: s.thresholdDesc ?? null,
        strategyMode: s.strategyMode ?? null,
      },
    });
  } catch (err: any) {
    // Snapshot failure must never abort a tick.
    console.warn(`[Auto-Kill] snapshot write failed for ${launch.campaignId}: ${err.message}`);
  }
}

/**
 * Recovery sweep — completes any kill that crashed between the Meta
 * `PAUSED` call and the bookkeeping transaction. graphPost(PAUSED) is
 * idempotent on already-paused campaigns, so re-calling it is safe.
 */
async function recoverPendingKills(): Promise<number> {
  const pending = await prisma.metaCampaignLaunch.findMany({
    where: { pendingKillStartedAt: { not: null }, killed: false },
  });
  let recovered = 0;
  for (const launch of pending) {
    if (!launch.pendingKillJson || !launch.pendingKillStartedAt) continue;
    let meta: any;
    try {
      meta = JSON.parse(launch.pendingKillJson);
    } catch {
      console.error(`[Auto-Kill] pendingKillJson unparseable for ${launch.campaignId}; clearing`);
      await prisma.metaCampaignLaunch.update({
        where: { id: launch.id },
        data: { pendingKillStartedAt: null, pendingKillJson: null },
      });
      continue;
    }
    try {
      await graphPost(`/${launch.campaignId}`, { status: "PAUSED" });
      await prisma.$transaction([
        prisma.metaCampaignLaunch.update({
          where: { id: launch.id },
          data: {
            killed: true,
            killedAt: launch.pendingKillStartedAt,
            killRule: meta.rule ?? null,
            pendingKillStartedAt: null,
            pendingKillJson: null,
          },
        }),
        prisma.metaAutoKillLog.create({
          data: {
            campaignId: launch.campaignId,
            campaignName: launch.campaignName,
            accountId: launch.accountId,
            rule: meta.rule ?? "unknown",
            spend: meta.spend ?? 0,
            metricName: meta.metricName ?? "",
            metricValue: meta.metricValue ?? 0,
            thresholdDesc: `${meta.thresholdDesc ?? "(recovered)"} [recovered]`,
            createdAt: launch.pendingKillStartedAt,
          },
        }),
      ]);
      invalidateCache(launch.campaignId);
      console.log(`[Auto-Kill] recovered pending kill for ${launch.campaignName} (${launch.campaignId})`);
      recovered++;
    } catch (err: any) {
      console.error(`[Auto-Kill] recovery failed for ${launch.campaignId}: ${err.message}`);
    }
  }
  return recovered;
}

// Per-process re-entrancy guard. Two ticks overlapping for the same
// runAutoKill call would both read pendingKillStartedAt: null, both
// write the kill, both POST PAUSED to Meta (idempotent), both write a
// MetaAutoKillLog row, both ping Slack. Cheaper than a Postgres advisory
// lock and good enough for the single-replica worker that owns this
// cron. If we ever multi-replica the worker, switch to pg_advisory_lock.
let autoKillRunning = false;

/**
 * ABO lane — evaluate and prune ONE campaign's ad sets.
 *
 * Reads ad-set-level insights (Meta's own numbers) rather than the Shopify
 * attribution the campaign-level rules use. That is not a shortcut: every ad
 * set in an ABO campaign points at the SAME landing page, so Shopify cannot
 * tell one angle's carts from another's. Meta is the only source with
 * per-ad-set attribution, and the thresholds in abo-kill.ts were calibrated
 * on those same Meta numbers, so the comparison is like-for-like.
 *
 * Pauses ad sets one at a time. The campaign row is only flipped to
 * `killed` once no angle is left running — until then the campaign must stay
 * selectable so the surviving angles keep being evaluated next tick.
 */
async function runAboKillForCampaign(
  launch: { id: number; campaignId: string; campaignName: string; accountId: string },
  rules: KillRules,
  result: AutoKillResult,
  since: string,
  until: string,
): Promise<void> {
  const [rows, adSets] = await Promise.all([
    fetchInsights({ since, until, level: "adset", campaignId: launch.campaignId }, launch.accountId),
    listAdSets(launch.accountId, { campaignIds: [launch.campaignId] }),
  ]);
  // Only ad sets Meta still reports as running are candidates — re-pausing a
  // dead one would log a second kill for the same angle on every tick.
  const live = new Map(adSets.filter((a) => a.status === "ACTIVE").map((a) => [a.id, a]));

  if (adSets.length === 0) {
    result.details.push({ campaignId: launch.campaignId, campaignName: launch.campaignName, action: "skip", reason: "abo: no ad sets" });
    return;
  }

  let killedHere = 0;
  for (const row of rows) {
    const adSetId = row.adset_id;
    if (!adSetId || !live.has(adSetId)) continue;

    const spendNative = parseFloat(row.spend) || 0;
    let spendUsd: number;
    try {
      spendUsd = convertSpendToUsd(spendNative, row.account_currency);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.details.push({ campaignId: launch.campaignId, campaignName: launch.campaignName, action: "error", reason: `abo: ${msg}` });
      continue;
    }

    const parsed = parseActions(row.actions);
    // `landing_page_view` is the visitor count the thresholds are built on
    // and parseActions does not surface it — read it straight off the row.
    const visitors = Number(
      (row.actions ?? []).find((a) => a.action_type === "landing_page_view")?.value ?? 0,
    );

    // Meta reports daily_budget in CENTS of the account currency. Absent on a
    // lifetime-budget ad set — leave it undefined so the spend backstop skips
    // rather than scaling against a made-up number.
    const budgetCents = Number(live.get(adSetId)?.daily_budget ?? 0);
    let dailyBudgetUsd: number | undefined;
    if (budgetCents > 0) {
      try {
        dailyBudgetUsd = convertSpendToUsd(budgetCents / 100, row.account_currency);
      } catch {
        dailyBudgetUsd = undefined;
      }
    }

    const stats: AboAdSetStats = {
      adSetId,
      adSetName: row.adset_name || adSetId,
      spendUsd,
      visitors,
      carts: parsed.addToCart,
      purchases: parsed.purchases,
      dailyBudgetUsd,
    };
    const verdict = evaluateAboAdSet(stats, rules);
    result.checked++;

    if (!verdict.kill) {
      result.details.push({
        campaignId: launch.campaignId,
        campaignName: `${launch.campaignName} › ${stats.adSetName}`,
        action: "pass",
        reason: verdict.reason,
      });
      continue;
    }

    try {
      await graphPost(`/${adSetId}`, { status: "PAUSED" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.details.push({ campaignId: launch.campaignId, campaignName: `${launch.campaignName} › ${stats.adSetName}`, action: "error", reason: `abo pause failed: ${msg}` });
      continue;
    }

    live.delete(adSetId);
    killedHere++;
    result.killed++;
    // Logged against the campaign (the log table is campaign-keyed) with the
    // angle named in thresholdDesc, so the kill log reads per-angle.
    await prisma.metaAutoKillLog.create({
      data: {
        campaignId: launch.campaignId,
        campaignName: `${launch.campaignName} › ${stats.adSetName}`,
        accountId: launch.accountId,
        rule: verdict.rule,
        spend: spendUsd,
        metricName: verdict.metricName,
        metricValue: verdict.metricValue,
        thresholdDesc: verdict.thresholdDesc,
      },
    });
    result.details.push({
      campaignId: launch.campaignId,
      campaignName: `${launch.campaignName} › ${stats.adSetName}`,
      action: "killed",
      reason: verdict.thresholdDesc,
    });
    notifyCampaignKilled({
      campaignName: `${launch.campaignName} › ${stats.adSetName}`,
      campaignId: launch.campaignId,
      rule: verdict.rule,
      spend: spendUsd,
      reason: verdict.thresholdDesc,
    }).catch(() => {});
  }

  // Every angle down = the campaign is over. Mark it killed so it drops out
  // of the candidate set; leave it alive while any angle still runs.
  if (live.size === 0 && killedHere > 0) {
    await prisma.metaCampaignLaunch.update({
      where: { id: launch.id },
      data: { killed: true, killedAt: new Date(), killRule: "abo_all_adsets" },
    });
    invalidateCache(launch.campaignId);
    result.details.push({ campaignId: launch.campaignId, campaignName: launch.campaignName, action: "killed", reason: "all ABO angles paused" });
  }
}

export async function runAutoKill(): Promise<AutoKillResult> {
  const rules = await getKillRules();
  const result: AutoKillResult = { checked: 0, killed: 0, skipped: 0, recovered: 0, details: [] };

  if (!rules.masterEnabled) {
    console.log("[Auto-Kill] Master toggle OFF, skipping");
    return result;
  }

  if (autoKillRunning) {
    console.log("[Auto-Kill] Previous tick still running, skipping this one");
    return result;
  }
  autoKillRunning = true;
  try {
    return await runAutoKillInner(result);
  } finally {
    autoKillRunning = false;
  }
}

async function runAutoKillInner(result: AutoKillResult): Promise<AutoKillResult> {
  const rules = await getKillRules();

  // Sweep crashed in-flight kills BEFORE evaluating new ones, so the
  // window query below doesn't see them as "alive" and re-evaluate.
  result.recovered = await recoverPendingKills();

  // Update last checked
  await saveKillRules({ lastChecked: new Date().toISOString() });

  // Per-tick cache for Meta-account → ShopifyStore.id lookups used
  // when measuring ATC/purchases in Shopify below.
  clearAttributionCache();

  // Watch window: campaigns whose Meta `start_time` is within the
  // last ~48h. Sourced from `metaStartTime` (read back from the Graph
  // API at registration), NOT the pipeline-intended launchDate —
  // those two used to drift up to 24h apart when scheduling spilled
  // across a UTC midnight, which silently hid day-1 spend from the
  // kill engine. Rows that pre-date the metaStartTime column fall
  // back to the legacy launchDate IN [yesterday, today] check so
  // un-backfilled launches keep being scanned.
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10);
  const startOfYesterdayUtc = new Date(`${yesterday}T00:00:00.000Z`);
  const launches = await prisma.metaCampaignLaunch.findMany({
    where: {
      OR: [
        { metaStartTime: { gte: startOfYesterdayUtc } },
        { AND: [{ metaStartTime: null }, { launchDate: { in: [yesterday, today] } }] },
      ],
      killed: false,
      // Exclude in-flight kills already covered by recoverPendingKills.
      pendingKillStartedAt: null,
    },
    include: {
      product: { select: { shopifyProductId: true } },
    },
  });

  if (launches.length === 0) {
    console.log(`[Auto-Kill] No tracked campaigns for ${yesterday}..${today}`);
    return result;
  }

  console.log(`[Auto-Kill] Checking ${launches.length} campaign(s) for ${yesterday}..${today}`);

  // Group by account
  const byAccount = new Map<string, typeof launches>();
  for (const l of launches) {
    if (!byAccount.has(l.accountId)) byAccount.set(l.accountId, []);
    byAccount.get(l.accountId)!.push(l);
  }

  for (const [accountId, accountLaunches] of byAccount) {
    let insightsMap: Record<string, any> = {};
    try {
      const rows = await fetchInsights({ since: yesterday, until: today, level: "campaign" }, accountId);
      for (const row of rows) {
        insightsMap[row.campaign_id!] = row;
      }
    } catch (err: any) {
      console.error(`[Auto-Kill] Failed to fetch insights for ${accountId}: ${err.message}`);
      continue;
    }

    let shopifyAtcMap = new Map<string, number>();
    try {
      shopifyAtcMap = await countShopifyAtcsForCampaigns({
        accountId,
        campaignIds: accountLaunches.map((l) => l.campaignId),
        // Match the spend window above (yesterday → today). last_3d
        // pulled an extra day's ATC, which masked new-day signal on
        // relaunched campaigns.
        datePreset: "last_2d",
      });
    } catch (err: any) {
      console.warn(`[Auto-Kill] Shopify ATC fetch failed for ${accountId}: ${err.message}. Falling back to Meta Pixel per-launch.`);
    }

    const collectionCampaignIds = accountLaunches
      .filter((l) => l.campaignType === "collection")
      .map((l) => l.campaignId);
    let collectionPurchasesMap = new Map<string, number>();
    if (collectionCampaignIds.length > 0) {
      try {
        collectionPurchasesMap = await countShopifyOrdersForCollectionCampaigns({
          accountId,
          campaignIds: collectionCampaignIds,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Auto-Kill] Shopify collection purchases fetch failed for ${accountId}: ${msg}. Collection rule will skip on missing data.`);
      }
    }

    for (const launch of accountLaunches) {
      result.checked++;

      if (!launch.autoKillEnabled) {
        result.skipped++;
        const reason = "auto-kill disabled";
        result.details.push({ campaignId: launch.campaignId, campaignName: launch.campaignName, action: "skip", reason });
        await persistSnapshot(launch, { outcome: "skip", skipReason: reason });
        continue;
      }

      if (launch.snoozedUntil && new Date(launch.snoozedUntil) > new Date()) {
        result.skipped++;
        const reason = `snoozed until ${new Date(launch.snoozedUntil).toLocaleTimeString()}`;
        result.details.push({ campaignId: launch.campaignId, campaignName: launch.campaignName, action: "skip", reason });
        await persistSnapshot(launch, { outcome: "skip", skipReason: reason });
        continue;
      }

      // ── ABO lane ─────────────────────────────────────────────────
      // Budget sits on each ad set, so the unit of judgement is the AD SET
      // (= one pain-point angle), not the campaign. Pausing the campaign
      // here would stop every angle at once and end the test instead of
      // pruning the loser. Handled entirely by runAboKillForCampaign, which
      // pauses ad sets individually; the campaign row is only marked killed
      // once every angle is down.
      if (launch.budgetType === "abo") {
        try {
          await runAboKillForCampaign(launch, rules, result, yesterday, today);
        } catch (err) {
          result.skipped++;
          const reason = `abo evaluation failed: ${err instanceof Error ? err.message : String(err)}`;
          result.details.push({ campaignId: launch.campaignId, campaignName: launch.campaignName, action: "error", reason });
          await persistSnapshot(launch, { outcome: "skip", skipReason: reason });
        }
        continue;
      }

      const row = insightsMap[launch.campaignId];
      if (!row) {
        const reason = "no insights yet";
        result.details.push({ campaignId: launch.campaignId, campaignName: launch.campaignName, action: "skip", reason });
        await persistSnapshot(launch, { outcome: "skip", skipReason: reason });
        continue;
      }

      const spendNative = parseFloat(row.spend) || 0;
      const accountCurrency: string | undefined = row.account_currency;
      const cpcNative = parseFloat(row.cost_per_inline_link_click ?? "") || 0;

      // F3: convertSpendToUsd now throws on unknown currency. Catch per-
      // campaign and skip rather than aborting the entire tick.
      let spend: number;
      let cpc: number;
      try {
        spend = convertSpendToUsd(spendNative, accountCurrency);
        cpc = convertSpendToUsd(cpcNative, accountCurrency);
      } catch (err: any) {
        result.skipped++;
        const reason = err.message;
        result.details.push({ campaignId: launch.campaignId, campaignName: launch.campaignName, action: "error", reason });
        await persistSnapshot(launch, { outcome: "skip", skipReason: reason, spendNative, currency: accountCurrency });
        continue;
      }

      const actions = parseActions(row.actions);
      const linkClicks = actions.linkClicks;
      const isCollection = launch.campaignType === "collection";

      let purchases = actions.purchases;
      let signalSource: "meta" | "shopify" = "meta";
      let collectionPurchases: number | null = null;

      const shopifyAtc = shopifyAtcMap.get(launch.campaignId);
      const atc: number | null = shopifyAtc ?? null;
      if (shopifyAtc != null) signalSource = "shopify";

      if (isCollection) {
        const shopifyCollPurchases = collectionPurchasesMap.get(launch.campaignId);
        if (shopifyCollPurchases != null) {
          collectionPurchases = shopifyCollPurchases;
          purchases = shopifyCollPurchases;
          signalSource = "shopify";
        }
      } else {
        let shopifyProductId = launch.product?.shopifyProductId ?? null;
        if (!shopifyProductId && launch.productPath) {
          const connectedStoreId = await resolveConnectedStoreIdForAccount(launch.accountId);
          if (connectedStoreId) {
            shopifyProductId = await resolveShopifyProductIdFromPath(
              connectedStoreId,
              launch.productPath
            );
          }
        }
        const shopifyStoreId = await resolveStoreForAccount(launch.accountId);
        if (!shopifyStoreId || !shopifyProductId) {
          result.skipped++;
          const reason = !shopifyStoreId
            ? `no Shopify store mapped to Meta account ${launch.accountId}`
            : "launch is not linked to a shopifyProductId (and productPath didn't resolve)";
          result.details.push({ campaignId: launch.campaignId, campaignName: launch.campaignName, action: "skip", reason });
          await persistSnapshot(launch, { outcome: "skip", skipReason: reason, spend, spendNative, currency: accountCurrency, linkClicks, cpc, atc });
          continue;
        }
        // F2 fix: prefer Meta's actual start instant (stored at registration)
        // over launchDate-midnight. Falls back to old behaviour for legacy
        // rows that pre-date the schema addition.
        const since = launch.launchInstant ?? new Date(`${launch.launchDate}T00:00:00.000Z`);
        purchases = await countShopifyOrders({
          storeId: shopifyStoreId,
          shopifyProductId,
          since,
        });
        if (shopifyAtc == null) signalSource = "shopify";
      }

      const warmupScale = launch.warmupActive ? getWarmupScaleFactor(launch.warmupProfile, launch.warmupDay) : 1;
      // Warmup scaling still applies to every spend checkpoint, including
      // the new fixed CPC gate — a campaign running at 50% warmup budget
      // shouldn't be evaluated as if it were at full spend.
      // rules.cpcSpendMin is operator-tunable from the auto-kill UI; falls
      // back to CPC_CHECKPOINT_SPEND when the settings row is missing the field.
      const cpcCheckpointSpend = (rules.cpcSpendMin ?? CPC_CHECKPOINT_SPEND) * warmupScale;
      const atcSpendMin = rules.atcSpendMin * warmupScale;
      const saleSpendMin = rules.saleSpendMin * warmupScale;
      const collectionSpendMin = rules.collectionSpendMin * warmupScale;

      let shouldKill = false;
      let rule = "";
      let metricName = "";
      let metricValue = 0;
      let thresholdDesc = "";
      // Set true when we should flip cpcCheckDone in DB after this tick
      // (rule 2a or 2b non-kill path).
      let retireCpcGate = false;
      const warmupTag = warmupScale < 1 ? ` [warmup ${(warmupScale * 100).toFixed(0)}%]` : "";
      let strategyMode: string | null = null;

      // ─── New CPC-gate state machine — see file header for truth table ───
      //
      // Order matters. Step 1: sale = immunity. Step 2: one-shot CPC
      // gate, evaluated only while !cpcCheckDone. Steps 3-5: standard
      // ATC / Sale / Collection thresholds.
      //
      // Master per-rule toggles (cpcEnabled, atcEnabled, saleEnabled,
      // collectionSaleEnabled) gate each rule's KILL action — the gate
      // logic itself runs either way so cpcCheckDone tracking stays
      // consistent across toggle flips.

      const hasSale = (purchases ?? 0) > 0;

      if (hasSale) {
        // Rule 1 — sale = total immunity. Don't even evaluate the rest.
        // No-op; falls through to the !shouldKill branch below.
      } else if (isCollection) {
        strategyMode = "collection";
        // Collection campaigns skip the CPC/ATC gate (their kill is
        // purely sale-based at the higher $60 checkpoint).
        if (
          spend >= collectionSpendMin &&
          rules.collectionSaleEnabled &&
          collectionPurchases !== null &&
          collectionPurchases === 0
        ) {
          shouldKill = true;
          rule = "collection_sale";
          metricName = "Purchases";
          metricValue = 0;
          thresholdDesc = `$${spend.toFixed(2)} spend, 0 purchases (collection, ${signalSource})${warmupTag}`;
        }
      } else {
        // Budget-scaled sale-only mode (high-budget launches): drop the
        // CPC/ATC gates and kill if no sale by ratio × daily budget.
        const launchBudgetUsd =
          launch.launchDailyBudget != null
            ? convertSpendToUsd(launch.launchDailyBudget, accountCurrency)
            : null;
        strategyMode = resolveKillStrategyMode({
          campaignType: launch.campaignType,
          launchBudgetUsd,
          rules,
        });

        if (strategyMode === "budget_sale" && launchBudgetUsd != null) {
          const { kill, checkpointUsd } = evaluateBudgetSaleKill({
            launchBudgetUsd,
            spendUsd: spend,
            purchases: purchases ?? 0,
            rules,
          });
          if (kill) {
            shouldKill = true;
            rule = "budget_sale";
            metricName = "Purchases";
            metricValue = 0;
            const pct = Math.round(rules.saleBudgetRatio * 100);
            thresholdDesc = `$${spend.toFixed(2)} spend ≥ $${checkpointUsd.toFixed(2)} ` +
              `(${pct}% of $${launchBudgetUsd.toFixed(0)} budget), 0 purchases (${signalSource})`;
          }
          // In this mode the CPC/ATC/sale ladder below is skipped entirely.
        } else {
          // Product campaigns — full ladder.
          if (!launch.cpcCheckDone) {
            // Step 2a: early ATC retires the CPC gate.
            if (atc !== null && atc > 0) {
              retireCpcGate = true;
            } else if (spend >= cpcCheckpointSpend) {
              // Step 2b: at the $10 checkpoint, decide once.
              retireCpcGate = true;
              // KILL only when CPC strictly > threshold (or no clicks at all).
              // ATC is known to be 0 here (otherwise 2a would have caught it).
              const cpcAboveThreshold = linkClicks === 0 || cpc > rules.cpcThreshold;
              if (rules.cpcEnabled && cpcAboveThreshold) {
                shouldKill = true;
                rule = "cpc";
                metricName = "CPC";
                metricValue = linkClicks === 0 ? -1 : Math.round(cpc * 100) / 100;
                thresholdDesc = linkClicks === 0
                  ? `$${spend.toFixed(2)} spend, 0 clicks${warmupTag}`
                  : `$${spend.toFixed(2)} spend, CPC $${cpc.toFixed(2)} > $${rules.cpcThreshold}${warmupTag}`;
              }
            }
            // If neither 2a nor 2b matched (spend < $10 AND no ATC yet),
            // do nothing — campaign stays in the gate until next tick.
          }

          // Steps 3-5 only run when the gate didn't already kill. If the
          // CPC gate was retired this tick, ATC/Sale can still fire at
          // their higher checkpoints if applicable.
          if (!shouldKill) {
            if (atc !== null && atc === 0 && spend >= atcSpendMin && rules.atcEnabled) {
              shouldKill = true;
              rule = "atc";
              metricName = "ATC";
              thresholdDesc = `$${spend.toFixed(2)} spend, 0 ATC (${signalSource})${warmupTag}`;
            } else if (purchases === 0 && spend >= saleSpendMin && rules.saleEnabled) {
              shouldKill = true;
              rule = "sale";
              metricName = "Purchases";
              thresholdDesc = `$${spend.toFixed(2)} spend, 0 purchases (${signalSource})${warmupTag}`;
            }
          }
        }
      }

      // Persist the gate-retired flag BEFORE the kill machinery so a
      // crash mid-kill doesn't leave us re-evaluating the CPC rule on
      // the next tick. Idempotent — already-true rows are unaffected.
      if (retireCpcGate && !launch.cpcCheckDone) {
        try {
          await prisma.metaCampaignLaunch.update({
            where: { id: launch.id },
            data: { cpcCheckDone: true },
          });
        } catch (err: any) {
          console.warn(`[Auto-Kill] cpcCheckDone write failed for ${launch.campaignId}: ${err.message}`);
        }
      }

      if (shouldKill) {
        // F1 fix: 3-phase atomic kill with crash recovery.
        //   Phase 1: persist intent (so recovery sweep can resume on crash).
        //   Phase 2: pause on Meta (idempotent if already paused).
        //   Phase 3: commit kill state + log atomically.
        // If any phase past 1 fails, pendingKill state is left set; the
        // next tick's recoverPendingKills() finishes the job.
        console.log(`[Auto-Kill] KILLING ${launch.campaignName}: ${thresholdDesc}`);
        const pendingStartedAt = new Date();
        const pendingMeta = { rule, spend, metricName, metricValue, thresholdDesc };

        try {
          await prisma.metaCampaignLaunch.update({
            where: { id: launch.id },
            data: {
              pendingKillStartedAt: pendingStartedAt,
              pendingKillJson: JSON.stringify(pendingMeta),
            },
          });
        } catch (err: any) {
          console.error(`[Auto-Kill] intent write failed for ${launch.campaignId}: ${err.message}`);
          result.details.push({ campaignId: launch.campaignId, campaignName: launch.campaignName, action: "error", reason: `intent write failed: ${err.message}` });
          await persistSnapshot(launch, { outcome: "skip", skipReason: `intent write failed: ${err.message}`, spend, spendNative, currency: accountCurrency, linkClicks, cpc, atc, purchases });
          continue;
        }

        try {
          await graphPost(`/${launch.campaignId}`, { status: "PAUSED" });
        } catch (err: any) {
          console.error(`[Auto-Kill] pause failed for ${launch.campaignId} (will recover next tick): ${err.message}`);
          result.details.push({ campaignId: launch.campaignId, campaignName: launch.campaignName, action: "error", reason: `pause failed: ${err.message}` });
          await persistSnapshot(launch, { outcome: "skip", skipReason: `pause failed: ${err.message}`, spend, spendNative, currency: accountCurrency, linkClicks, cpc, atc, purchases });
          continue;
        }

        try {
          await prisma.$transaction([
            prisma.metaCampaignLaunch.update({
              where: { id: launch.id },
              data: {
                killed: true,
                killedAt: pendingStartedAt,
                killRule: rule,
                pendingKillStartedAt: null,
                pendingKillJson: null,
              },
            }),
            prisma.metaAutoKillLog.create({
              data: {
                campaignId: launch.campaignId,
                campaignName: launch.campaignName,
                accountId: launch.accountId,
                rule,
                spend,
                metricName,
                metricValue,
                thresholdDesc,
                createdAt: pendingStartedAt,
              },
            }),
          ]);
          invalidateCache(launch.campaignId);
          result.killed++;
          result.details.push({ campaignId: launch.campaignId, campaignName: launch.campaignName, action: "killed", reason: thresholdDesc });
          await persistSnapshot(launch, {
            outcome: "killed", killRule: rule, spend, spendNative, currency: accountCurrency,
            linkClicks, cpc, atc, purchases, thresholdDesc, strategyMode,
          });
          notifyCampaignKilled({ campaignName: launch.campaignName, campaignId: launch.campaignId, rule, spend, reason: thresholdDesc }).catch(() => {});
        } catch (err: any) {
          // Meta is paused; pendingKill state preserved → recovery sweep
          // on next tick will retry the bookkeeping commit.
          console.error(`[Auto-Kill] commit failed post-pause for ${launch.campaignId} (will recover): ${err.message}`);
          result.details.push({ campaignId: launch.campaignId, campaignName: launch.campaignName, action: "killed-pending", reason: thresholdDesc });
          await persistSnapshot(launch, { outcome: "skip", skipReason: `pending: ${err.message}`, spend, spendNative, currency: accountCurrency, linkClicks, cpc, atc, purchases });
        }
      } else {
        const passReason = spend < cpcCheckpointSpend
          ? `spend $${spend.toFixed(2)} below threshold`
          : `passed at $${spend.toFixed(2)}`;
        result.details.push({ campaignId: launch.campaignId, campaignName: launch.campaignName, action: "pass", reason: passReason });
        await persistSnapshot(launch, {
          outcome: "pass", spend, spendNative, currency: accountCurrency,
          linkClicks, cpc, atc, purchases, strategyMode,
        });
      }
    }
  }

  console.log(`[Auto-Kill] Done: checked ${result.checked}, killed ${result.killed}, recovered ${result.recovered}`);
  return result;
}

/* ─── Snooze ─── */

export async function snoozeCampaign(campaignId: string, hours: number) {
  const snoozedUntil = new Date(Date.now() + hours * 3600_000);
  await prisma.metaCampaignLaunch.update({
    where: { campaignId },
    data: { snoozedUntil },
  });
  return { campaignId, snoozedUntil };
}

export async function unsnoozeCampaign(campaignId: string) {
  await prisma.metaCampaignLaunch.update({
    where: { campaignId },
    data: { snoozedUntil: null },
  });
}

/* ─── Kill Log ─── */

export async function getKillLog(limit = 50) {
  return prisma.metaAutoKillLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** Get kill counts per day for the last N days. */
export async function getKillsPerDay(days = 30): Promise<{ date: string; count: number }[]> {
  const since = new Date(Date.now() - days * 86400_000);
  const logs = await prisma.metaAutoKillLog.findMany({
    where: { createdAt: { gte: since } },
    select: { createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const counts = new Map<string, number>();
  for (const log of logs) {
    const date = log.createdAt.toISOString().slice(0, 10);
    counts.set(date, (counts.get(date) || 0) + 1);
  }

  // Fill in missing days with 0
  const result: { date: string; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    result.push({ date: d, count: counts.get(d) || 0 });
  }
  return result;
}

export async function getTrackedCampaigns(date?: string) {
  const launchDate = date || new Date().toISOString().slice(0, 10);
  return prisma.metaCampaignLaunch.findMany({
    where: { launchDate },
    orderBy: { createdAt: "desc" },
  });
}
