import prisma from "@/lib/db";
import { applyPricingChange } from "./apply-change";
import { getCachedRate, type CachedRate } from "@/lib/fx/get-rate";
import { getPricingOverview, type OverviewProduct } from "./overview";
import {
  charmPrice,
  charmStep,
  isBerWithinBand,
  isWithinCooldown,
} from "@/lib/pricing";
import { nextFireFromCron } from "./cron-presets";

export interface AutoApplyTickArgs {
  scheduleId: string;
  tickAt: Date;
  /**
   * Optional filter: when set, only process these ShopifyProduct.id values.
   * Used by the order-webhook trigger to fire auto-apply for just the
   * products on a fresh order. Omit for the cron sweep (all products).
   */
  productIds?: string[];
  /**
   * Tag describing what fired this tick. Persisted onto every
   * PricingChange row written during the tick so /pricing/history can
   * show exactly what caused each change. See applyPricingChange's
   * `triggerReason` field for the conventional values. Defaults to
   * "cron" when omitted (the daily safety-sweep).
   */
  triggerReason?: string;
  /** Test-only injection: skip the overview fetcher and use these. */
  _testOverrideProducts?: OverviewProduct[];
  /** Test-only injection: skip getCachedRate. */
  _testFxRate?: CachedRate;
}

export interface AutoApplyTickResult {
  applied: number;
  suppressed: number;
  failed: number;
  totalChangeUsd: number;
  skipped: boolean;
}

const SHOPIFY_FAILURE_THRESHOLD = 3;
// Force-refresh the FX cache if a tick lands with a rate older than
// this. The scheduled refresh runs every 6h; this catches the case
// where it's been missed (worker downtime, transient provider
// failure, infrequent ticks) before we apply a price.
const FX_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export async function runAutoApplyTick(
  args: AutoApplyTickArgs,
): Promise<AutoApplyTickResult> {
  if (process.env.PRICING_AUTOAPPLY_DISABLE === "1") {
    return { applied: 0, suppressed: 0, failed: 0, totalChangeUsd: 0, skipped: true };
  }

  const sched = await prisma.pricingSchedule.findUnique({
    where: { id: args.scheduleId },
  });
  if (!sched || !sched.enabled || sched.disabledAt != null) {
    return { applied: 0, suppressed: 0, failed: 0, totalChangeUsd: 0, skipped: true };
  }

  const products = args._testOverrideProducts ?? (await fetchProducts(sched.storeId, args.productIds));
  if (products.length === 0) {
    await prisma.pricingSchedule.update({
      where: { id: args.scheduleId },
      data: { lastRunAt: args.tickAt },
    });
    return { applied: 0, suppressed: 0, failed: 0, totalChangeUsd: 0, skipped: false };
  }

  // Cooldown source-of-truth: the most recent *successful* price change
  // per product, across EVERY trigger path (cron sweep, invoice-driven
  // reprice, and manual operator Apply). One batched query keyed by
  // productId — so an invoice tick and the nightly cron can't both move
  // the same product inside the window, and the cron won't revert a
  // human's fresh manual cut.
  const lastSuccessByProduct = new Map<string, Date>();
  {
    const rows = await prisma.pricingChange.groupBy({
      by: ["productId"],
      where: {
        storeId: sched.storeId,
        status: "success",
        productId: { in: products.map((p) => p.productId) },
      },
      _max: { createdAt: true },
    });
    for (const r of rows) {
      if (r._max.createdAt) lastSuccessByProduct.set(r.productId, r._max.createdAt);
    }
  }

  const settingsSnapshotJson = JSON.stringify(sched);
  let applied = 0;
  let failed = 0;
  let totalChangeUsd = 0;
  let consecutiveFailuresThisTick = 0;
  let circuitBreakerTripped = false;

  for (const p of products) {
    if (p.cogsUsd == null || p.cogsUsd <= 0) continue;
    const currency = p.storeCurrency ?? null;
    if (!currency) continue;

    const fx =
      args._testFxRate ?? (await getCachedRate(currency, { maxAgeMs: FX_MAX_AGE_MS }));

    const suggested = computeSuggestedStorePrice({
      cogsUsd: p.cogsUsd,
      feeRate: p.feeRate,
      listPriceStore: p.listPriceStore,
      listPriceUsd: p.listPriceUsd,
      targetBer: sched.targetBer,
      fxRateUsd: fx.rateUsd,
    });
    if (suggested == null) continue;
    const suggestedStore = suggested;

    // Match review-page "actionable" gate: skip if the suggestion equals
    // the current list price within rounding.
    if (Math.abs(suggestedStore - p.listPriceStore) <= 0.01) continue;

    // Churn guard 1 — BER-deviation band: leave products that are already
    // close to target BER alone (the bulk of the daily noise). Mirrors the
    // /pricing page's "actionable" gate so UI and automation agree.
    if (isBerWithinBand(p.berRoas, sched.targetBer)) continue;

    // Churn guard 2 — cooldown: a product moved (by anyone) inside the
    // window is off-limits until it settles, so noisy per-tick cogs/FX
    // drift can't flip-flop the price and the cron can't revert a recent
    // manual change.
    if (isWithinCooldown(lastSuccessByProduct.get(p.productId) ?? null, args.tickAt)) {
      continue;
    }

    let newCompareAtStore: number | null = null;
    if (p.compareAtPriceStore != null && p.listPriceStore > 0) {
      const scaled = p.compareAtPriceStore * (suggestedStore / p.listPriceStore);
      const charmed = charmPrice(scaled);
      newCompareAtStore = charmed > suggestedStore ? charmed : scaled;
    }

    const baseArgs = {
      productId: p.productId,
      storeId: sched.storeId,
      source: "auto" as const,
      scheduleId: args.scheduleId,
      tickAt: args.tickAt,
      triggerReason: args.triggerReason ?? "cron",
      currency,
      oldListStore: p.listPriceStore,
      newListStore: suggestedStore,
      oldCompareAtStore: p.compareAtPriceStore,
      newCompareAtStore,
      oldBer: p.berRoas,
      newBer: sched.targetBer,
      targetBer: sched.targetBer,
      cogsUsd: p.cogsUsd,
      cogsSampleSize: p.sampleSize,
      feeRate: p.feeRate,
      feeRateSource: p.feeRateSource,
      usdRate: fx.rateUsd,
      usdRateSource: fx.source,
      usdRateFetchedAt: fx.fetchedAt,
      settingsSnapshotJson,
      variants: p.variantIds.map((id) => ({
        shopifyVariantId: id,
        oldPrice: p.variantPrices[id] ?? p.listPriceStore,
        newPrice: suggestedStore,
        oldCompareAt: p.variantCompareAt[id] ?? null,
        newCompareAt: newCompareAtStore,
      })),
    };

    if (sched.dryRun) {
      await applyPricingChange({ ...baseArgs, dryRun: true });
      continue;
    }

    const out = await applyPricingChange(baseArgs);
    if (out.status === "success") {
      applied++;
      totalChangeUsd += (suggestedStore - p.listPriceStore) * fx.rateUsd;
      consecutiveFailuresThisTick = 0;
    } else if (out.status === "failed") {
      failed++;
      consecutiveFailuresThisTick++;
      if (consecutiveFailuresThisTick >= SHOPIFY_FAILURE_THRESHOLD) {
        await disableScheduleAndAlert(args.scheduleId, sched.slackOnError);
        circuitBreakerTripped = true;
        break;
      }
    }
  }

  // Counts consecutive *ticks* that produced no successful apply — not
  // total failures within a tick. A 5-fail tick advances this by 1, not
  // 5, so the threshold reflects sustained problems across ticks rather
  // than a single bursty batch (the in-tick SHOPIFY_FAILURE_THRESHOLD
  // already short-circuits the latter).
  const nextConsecutive =
    applied > 0
      ? 0
      : failed > 0
        ? sched.consecutiveFailures + 1
        : sched.consecutiveFailures;

  await prisma.pricingSchedule.update({
    where: { id: args.scheduleId },
    data: {
      lastRunAt: args.tickAt,
      // Push nextRunAt forward whether the tick was triggered by the
      // cron sweep, the invoice ingester, or anything else — keeps the
      // daily safety-sweep from firing right after invoice work was
      // just completed.
      nextRunAt: nextFireFromCron(sched.cronPreset, new Date()),
      consecutiveFailures: nextConsecutive,
    },
  });

  return { applied, suppressed: 0, failed, totalChangeUsd, skipped: false };
}

/**
 * Pure per-product price calculation, shared semantics with the review
 * UI at src/app/pricing/page.tsx:264 (`enriched` memo) and the manual
 * Apply route at src/app/api/pricing/apply/[productId]/route.ts.
 *
 * Returns the charmed store-currency suggestion, or null when:
 *   - the BER math is infeasible for the given target / fee rate
 *   - the resulting price would be non-positive
 *   - the suggestion lands within the 0.01 deadband around the current
 *     list price (so the tick is a no-op for this product)
 *
 * IMPORTANT — FX source:
 *   When the product has a populated USD baseline (`listPriceUsd > 0`)
 *   we use its baked-in store↔USD ratio (`listPriceStore /
 *   listPriceUsd`), exactly like the UI. Without this, normal daily
 *   FX wobble produces a suggested price that lands within the
 *   deadband, the tick silently no-ops, and the operator sees the same
 *   products in "Needs correction" forever while believing automation
 *   is broken. We only fall back to the live cached FX rate
 *   (`fxRateUsd`) when the product has no historical USD basis (brand
 *   new SKU with no orders yet — listPriceUsd is 0 in that case).
 */
export function computeSuggestedStorePrice(args: {
  cogsUsd: number;
  feeRate: number;
  listPriceStore: number;
  listPriceUsd: number;
  targetBer: number;
  fxRateUsd: number;
}): number | null {
  const usdToStore =
    args.listPriceUsd > 0 && args.listPriceStore > 0
      ? args.listPriceStore / args.listPriceUsd
      : args.fxRateUsd > 0
        ? 1 / args.fxRateUsd
        : 0;
  if (usdToStore <= 0) return null;

  const denom = args.targetBer * (1 - args.feeRate) - 1;
  if (denom <= 0) return null;

  const suggestedUsd = (args.targetBer * args.cogsUsd) / denom;
  const rawSuggestedStore = suggestedUsd * usdToStore;
  const suggestedStore = charmPrice(rawSuggestedStore);
  if (suggestedStore <= 0) return null;

  // Match review-page "actionable" gate: skip if the suggestion equals
  // the current list price within rounding.
  if (Math.abs(suggestedStore - args.listPriceStore) <= 0.01) return null;

  // Hysteresis at charm-step boundaries. `charmPrice()` snaps raw to
  // the nearest "X9 / X99" value at a fixed step per price level (100
  // at ≥1000, 10 at 20–999, 1 at 1–19). When raw sits near a charm
  // boundary, sub-1% drift in cogs / FX between ticks can flip the
  // rounding direction, so consecutive ticks emit two adjacent charm
  // values (e.g. raw ≈ 2050 → 1999 one tick and 2099 the next). The
  // 0.01 deadband above doesn't catch this — the charm flip looks
  // like a 100-unit "change." Without this guard, the auto-apply
  // scheduler ping-pongs the price between the two values forever
  // (incident 2026-05-21: NOVA Cape Town).
  //
  // If list is closer to raw than one charm step at this price level,
  // the apparent change is rounding-boundary noise — no-op. Legitimate
  // moves (raw more than one charm step from list) still go through.
  if (Math.abs(rawSuggestedStore - args.listPriceStore) < charmStep(args.listPriceStore)) {
    return null;
  }

  // 2026-06-02: raise-only policy removed — cuts now auto-apply too (no
  // human in the loop). The 2026-05-21 daily margin-erosion churn is
  // instead prevented by churn guards in `runAutoApplyTick` (a
  // BER-deviation band so near-on-target products are left alone, plus a
  // multi-day cooldown so a product can't flip-flop on noisy per-tick
  // cogs/FX drift). This pure function returns the BER-optimal charmed
  // price in either direction; the tick decides whether to act.
  return suggestedStore;
}

async function fetchProducts(
  storeId: string,
  productIds?: string[],
): Promise<OverviewProduct[]> {
  const overview = await getPricingOverview([storeId], productIds);
  if (!overview.ok) return [];
  return overview.products.filter(
    (p) =>
      p.cogsUsd != null &&
      Math.abs(p.listPriceStore) > 0 &&
      p.variantCount > 0,
  );
}

async function disableScheduleAndAlert(
  scheduleId: string,
  slackOnError: boolean,
): Promise<void> {
  await prisma.pricingSchedule.update({
    where: { id: scheduleId },
    data: {
      disabledAt: new Date(),
      disabledReason: "3 consecutive Shopify failures",
      consecutiveFailures: SHOPIFY_FAILURE_THRESHOLD,
    },
  });
  if (slackOnError && process.env.SLACK_WEBHOOK_URL) {
    try {
      await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `:warning: Pricing auto-apply disabled (schedule ${scheduleId}) — 3 consecutive Shopify failures`,
        }),
      });
    } catch {
      // best-effort
    }
  }
}
