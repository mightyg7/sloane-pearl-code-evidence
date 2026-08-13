import prisma from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { decideTopup, type TopupConfig, type TopupDecisionInput } from "./topup-executor";
import { quoteAdHoc, submitPayout } from "./payout-executor";
import { listAccountsNeedingTopup } from "@/lib/meta-ads/balance-alerts-data";
import { notifyTopupSkipped } from "./discord-notifier";
import { computeTopupTreasuryPosition, type TreasuryPosition } from "./topup-treasury";
import { TOPUP_DEFAULTS } from "./topup-defaults";
import { opsAlert } from "@/lib/ops-alert";
import { selectDefaultBeneficiary } from "./beneficiary-selection";
import { parseAgencyConfig, resolveRail, AgencyConfigError } from "./topup-rails";

export interface TopupTickOutput {
  fired: number;
  skipped: number;
}

// Internal ops alerts. These are operational diagnostics and route to the
// internal ops channel (opsAlert → OPS_ALERT_WEBHOOK_URL), NOT #agency-top-up
// — that channel is agency-facing and carries only real top-up requests +
// receipts. opsAlert's DB-backed throttle survives worker restarts.
async function notifyTreasuryReadFailed(error: string): Promise<void> {
  console.warn("[airwallex.topup] treasury_read_failed:", error);
  await opsAlert({
    severity: "warn",
    source: "auto-topup",
    title: "Treasury read failed — auto-topup deferred this tick",
    detail: error.slice(0, 1000),
    dedupeKey: "treasury_read_failed",
    throttleHours: 1,
  });
}
async function notifyTopupStuck(args: {
  counterpartyId: string;
  metaAdAccountId: string;
  error: string;
}): Promise<void> {
  console.warn("[airwallex.topup] topup_stuck:", args);
  // critical: submit threw AFTER the payout may have gone live — a human
  // should reconcile before the next fire window.
  await opsAlert({
    severity: "critical",
    source: "auto-topup",
    title: "Auto-topup STUCK — submit threw mid-flight",
    detail:
      `Counterparty: ${args.counterpartyId}\n` +
      `Ad account: ${args.metaAdAccountId}\n` +
      `Error: ${args.error.slice(0, 1000)}`,
    dedupeKey: `${args.counterpartyId}:${args.metaAdAccountId}:stuck`,
    throttleHours: 24,
  });
}

export async function runTopupTick(): Promise<TopupTickOutput> {
  // Gate 0: global pause — Setting OR env kill switch. Either short-circuits
  // the entire tick. The Setting variant is operator-friendly (toggle from the
  // dashboard, no redeploy); the env variant is the original Phase 2a switch.
  const pauseRow = await prisma.setting.findUnique({
    where: { key: "airwallex_topup_paused_global" },
  });
  const settingPaused = pauseRow?.value === "true";
  const envKillSwitch = process.env.AIRWALLEX_AUTOTOPUP_DISABLED === "true";
  if (settingPaused) {
    // The env kill switch still flows through decideTopup as `killSwitch: true`
    // so individual fires get a SKIP row recorded — useful for audit. But the
    // Setting-level pause means "stop entirely, don't even iterate" — no fire
    // rows, no Discord noise. This matches the v3 plan: a deliberate
    // operator-initiated halt.
    return { fired: 0, skipped: 0 };
  }
  const killSwitch = envKillSwitch;

  // Step 1: snapshot treasury once per tick. All decideTopup() calls below
  // share the same treasury — we don't re-read after each fire because
  // inTickCommittedHkd does the within-tick budgeting locally.
  let treasury: TreasuryPosition;
  try {
    treasury = await computeTopupTreasuryPosition();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[airwallex.topup] treasury_read_failed", err);
    await notifyTreasuryReadFailed(errMsg);
    return { fired: 0, skipped: 0 };
  }

  // FX staleness short-circuit: even if treasury read succeeded, an old FX
  // rate means our HKD-conversion math is unreliable. Defer the tick rather
  // than fire with a possibly-mispriced amount.
  if (treasury.fxRateAgeMs > TOPUP_DEFAULTS.FX_MAX_STALE_HOURS * 3600_000) {
    await notifyTreasuryReadFailed("fx_stale");
    return { fired: 0, skipped: 0 };
  }

  // Step 2: candidate accounts (burn-aware via the v3.5 helper).
  const accounts = await listAccountsNeedingTopup();
  if (accounts.length === 0) {
    await writeLoopHealthTimestamp();
    return { fired: 0, skipped: 0 };
  }

  // Step 3: sort by ascending daysOfRunway — lowest runway = most urgent.
  // Infinity (paused accounts) sorts to the end naturally.
  accounts.sort((a, b) => (a.daysOfRunway ?? Infinity) - (b.daysOfRunway ?? Infinity));

  let fired = 0;
  let skipped = 0;
  let inTickCommittedHkd = 0;
  const dayMs = 24 * 3600 * 1000;
  const sinceCutoff = new Date(Date.now() - dayMs);

  for (const a of accounts) {
    const setting = await prisma.adAccountBalanceSetting.findUnique({
      where: { metaAdAccountId: a.id },
    });
    // Operator paused auto-topup for this account — never fire, keep config.
    if (setting?.autoTopupDisabled) continue;
    if (!setting?.agencyCounterpartyId) continue;

    const counterparty = await prisma.counterparty.findUnique({
      where: { id: setting.agencyCounterpartyId },
    });
    if (!counterparty) continue;

    // Parse + resolve the default rail once. A malformed config must not
    // halt the loop — other ad accounts still need their top-ups — so we
    // record a SKIPPED row, alert once, and move on.
    let railCfg: TopupConfig;
    try {
      railCfg = resolveRail(parseAgencyConfig(counterparty.topupConfigJson));
    } catch (err) {
      const detail = err instanceof AgencyConfigError ? err.message : String(err);
      await prisma.airwallexTopupFire.create({
        data: {
          counterpartyId: counterparty.id,
          metaAdAccountId: a.id,
          whatsappAdAccountCode: setting.whatsappAdAccountCode ?? null,
          decision: "SKIPPED",
          skipReason: "no_config",
          amount: new Prisma.Decimal(0),
          currency: counterparty.defaultCurrency,
          bankReference: "(unparseable config)",
          metaRemainingAtFire: a.remaining,
          metaThresholdAtFire: a.threshold,
          rawDetailsJson: { configError: detail } as unknown as Prisma.InputJsonValue,
        },
      });
      await opsAlert({
        severity: "warn",
        source: "auto-topup",
        title: `Agency top-up config unparseable — ${counterparty.name}`,
        detail: detail.slice(0, 1000),
        dedupeKey: `${counterparty.id}:config_unparseable`,
        throttleHours: 6,
      });
      skipped++;
      continue;
    }

    // Deterministic pick — see beneficiary-selection.ts. An agency holding more
    // than one active account must not have its top-up currency decided by row
    // order.
    const beneficiary = selectDefaultBeneficiary(
      await prisma.airwallexBeneficiary.findMany({
        where: { counterpartyId: counterparty.id, archivedAt: null },
      }),
      counterparty.defaultCurrency,
    );
    const recentFires = await prisma.airwallexTopupFire.findMany({
      where: { counterpartyId: counterparty.id, firedAt: { gt: sinceCutoff } },
      // Pull the linked payout's status so countsAsFired() can treat a
      // SKIPPED/STUCK row whose payout is still live (submit threw mid-flight)
      // as fired-for-cooldown — without this the double-pay guard is inert.
      include: { payout: { select: { status: true } } },
    });

    const input: TopupDecisionInput = {
      metaAdAccountId: a.id,
      remaining: a.remaining,
      threshold: a.threshold,
      counterparty: {
        id: counterparty.id,
        topupConfigJson: railCfg,
      },
      beneficiary: beneficiary ? { id: beneficiary.id } : null,
      recentFires: recentFires.map((f) => ({
        counterpartyId: f.counterpartyId,
        metaAdAccountId: f.metaAdAccountId,
        decision: f.decision,
        amount: f.amount.toString(),
        // The rail the persisted amount is denominated in. Gate 7's
        // per-agency cap is single-currency, so it must be able to tell a
        // USD fire from an HKD one.
        currency: f.currency,
        firedAt: f.firedAt,
        payoutStatus: f.payout?.status ?? null,
      })),
      nowCet: new Date(),
      killSwitch,
      whatsappAdAccountCode: setting.whatsappAdAccountCode,
      // v3 fields
      burn: a.burn
        ? {
            avgDailySpendNative: a.burn.avgDailySpendNative,
            spendCoverageDays: a.burn.spendCoverageDays,
            daysOfRunway: a.daysOfRunway,
          }
        : undefined,
      treasury: {
        airwallexAvailableHkd: treasury.airwallexAvailableHkd,
        pendingShopifyInflowHkd: treasury.pendingShopifyInflowHkd,
        pendingOutflowHkd: treasury.pendingOutflowHkd,
        safetyReserveHkd: treasury.safetyReserveHkd,
        fxRateEurHkd: treasury.fxRateEurHkd,
      },
      inTickCommittedHkd,
      rollingDailyTotalHkd: treasury.rollingDailyTotalHkd,
      rollingWeeklyTotalHkd: treasury.rollingWeeklyTotalHkd,
      perAccountOverrides: {
        triggerDays: setting.triggerDays,
        targetRunwayDays: setting.targetRunwayDays,
        minTopupEur: setting.minTopupEur ? Number(setting.minTopupEur) : null,
        maxTopupPerFireEur: setting.maxTopupPerFireEur
          ? Number(setting.maxTopupPerFireEur)
          : null,
      },
    };

    const decision = decideTopup(input);
    const baseRow = {
      counterpartyId: counterparty.id,
      metaAdAccountId: a.id,
      whatsappAdAccountCode: setting.whatsappAdAccountCode ?? null,
      metaRemainingAtFire: a.remaining,
      metaThresholdAtFire: a.threshold,
    };

    // Enriched rawDetailsJson for audit — decision plus the contextual
    // signals that drove it (burn snapshot, treasury snapshot, the
    // running in-tick total). Lets us reconstruct exactly why each row
    // landed where it did without replaying the tick.
    const rawDetails = {
      decision,
      burn: a.burn ?? null,
      daysOfRunway: a.daysOfRunway,
      treasurySnapshot: treasury,
      inTickCommittedHkd,
    };

    if (decision.kind === "FIRE") {
      const row = await prisma.airwallexTopupFire.create({
        data: {
          ...baseRow,
          decision: "FIRED",
          amount: new Prisma.Decimal(decision.amount.toString()),
          currency: decision.currency,
          bankReference: decision.bankReference,
          rawDetailsJson: rawDetails as unknown as Prisma.InputJsonValue,
        },
      });

      // Wrap submit in try/catch — a single account failing must not
      // halt the loop. On failure, mark this fire STUCK and continue.
      try {
        const quote = await quoteAdHoc({
          counterpartyId: counterparty.id,
          beneficiaryId: beneficiary!.id,
          amount: decision.amount.toFixed(2),
          currency: decision.currency,
          userId: "auto-topup-worker",
          reference: decision.bankReference,
        });
        await prisma.airwallexTopupFire.update({
          where: { id: row.id },
          data: { payoutId: quote.payoutId },
        });
        await submitPayout({ payoutId: quote.payoutId, userId: "auto-topup-worker" });

        // quote.payAmount is the source-currency amount (cfg.currency,
        // HKD for every PSM/ESM agency today). Add it directly to the
        // in-tick budget — no FX conversion needed on the HKD path.
        const payAmountHkd = parseFloat(quote.payAmount);
        inTickCommittedHkd += payAmountHkd;

        await prisma.adAccountBalanceSetting.update({
          where: { metaAdAccountId: a.id },
          data: {
            lastFireAt: new Date(),
            lastFireStatus: "fired",
            lastFireAmountHkd: new Prisma.Decimal(payAmountHkd.toString()),
            lastFireError: null,
          },
        });
        fired++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await prisma.airwallexTopupFire.update({
          where: { id: row.id },
          data: {
            decision: "STUCK",
            rawDetailsJson: {
              ...rawDetails,
              error: errMsg,
              erroredAt: new Date().toISOString(),
            } as unknown as Prisma.InputJsonValue,
          },
        });
        await prisma.adAccountBalanceSetting.update({
          where: { metaAdAccountId: a.id },
          data: {
            lastFireAt: new Date(),
            lastFireStatus: "stuck",
            lastFireError: errMsg.slice(0, 1000),
          },
        });
        await notifyTopupStuck({
          counterpartyId: counterparty.id,
          metaAdAccountId: a.id,
          error: errMsg,
        });
        skipped++;
      }
    } else {
      const fallbackAmount = railCfg.baseAmount;
      const fallbackRef = railCfg.bankReference;
      const fallbackCcy = railCfg.currency;
      await prisma.airwallexTopupFire.create({
        data: {
          ...baseRow,
          decision: "SKIPPED",
          skipReason: decision.reason,
          amount: new Prisma.Decimal(fallbackAmount.toString()),
          currency: fallbackCcy,
          bankReference: fallbackRef,
          rawDetailsJson: rawDetails as unknown as Prisma.InputJsonValue,
        },
      });
      await prisma.adAccountBalanceSetting.update({
        where: { metaAdAccountId: a.id },
        data: {
          lastFireAt: new Date(),
          lastFireStatus: `skipped:${decision.reason}`,
        },
      });
      await Promise.resolve(
        notifyTopupSkipped({
          counterpartyId: counterparty.id,
          counterpartyName: counterparty.name,
          metaAdAccountId: a.id,
          skipReason: decision.reason,
          detail: decision.detail,
        }),
      ).catch(() => undefined);
      skipped++;
    }
  }

  await writeLoopHealthTimestamp();
  return { fired, skipped };
}

/**
 * Heartbeat for the dashboard's "loop health" widget. We write the
 * ISO timestamp as a JSON-encoded string so the dashboard route can
 * parse it via `JSON.parse(setting.value)` uniformly with the other
 * JSON-shaped Setting values (e.g. the FX cache row).
 */
async function writeLoopHealthTimestamp(): Promise<void> {
  const nowIso = new Date().toISOString();
  const value = JSON.stringify(nowIso);
  await prisma.setting.upsert({
    where: { key: "airwallex_topup_last_tick_at" },
    create: { key: "airwallex_topup_last_tick_at", value },
    update: { value },
  });
}
