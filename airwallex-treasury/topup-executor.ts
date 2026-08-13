import { TOPUP_DEFAULTS } from "./topup-defaults";

export interface TopupConfig {
  baseAmount: number;
  currency: string;
  minAmount: number;
  feePercent: number;
  bankReference: string;
  payerName: string;
  whatsappContactName: string;
  windowDays: string[];
  windowStartCet: string;
  windowEndCet: string;
  cooldownHours: number;
  dailyCapAmount: number;
  bannedReferenceWords: string[];
  recoveryBuffer?: number;  // default 1.10; remaining must rise above threshold × this before next fire allowed
  fxRateCacheHours?: number; // default 1; per-counterparty override of FX_MAX_STALE_HOURS
}

// Active-payout states that count as "money has moved" for cooldown /
// daily-cap purposes — even if the wrapping AirwallexTopupFire was NOT
// marked FIRED because submit threw before the row could be finalised.
// Two such cases share this race:
//   - SKIPPED + reason=manual_submit_failed: a manual fire whose submit
//     threw mid-flight but left a real payout the reconciler is settling.
//   - STUCK: the auto-tick's own submit-failure decision (topup-tick.ts
//     flips a FIRED row to STUCK in the catch around submitPayout). The
//     payoutId is attached BEFORE submitPayout runs, and submitPayout
//     writes "submitting" to the payout BEFORE the API call ("crash
//     anchor"), so a timed-out submit leaves an ACTIVE payout — money may
//     already have moved at Airwallex even though our call threw.
// Without counting these, the next eligible tick re-fires the same top-up
// while the prior transfer is still settling — the textbook double-pay.
// A payout left "failed"/"draft"/"quoted"/"cancelled" (money never moved)
// is correctly NOT active, so a genuine pre-transfer failure stays
// retryable.
const ACTIVE_PAYOUT_STATES = new Set([
  "submitting", "submitted", "processing", "funded", "settled",
]);

function countsAsFired(f: {
  decision: string;
  payoutStatus?: string | null;
}): boolean {
  if (f.decision === "FIRED") return true;
  if (
    (f.decision === "SKIPPED" || f.decision === "STUCK") &&
    f.payoutStatus != null &&
    ACTIVE_PAYOUT_STATES.has(f.payoutStatus)
  ) {
    return true;
  }
  return false;
}

export interface TopupDecisionInput {
  metaAdAccountId: string;
  remaining: number;
  threshold: number;
  counterparty: { id: string; topupConfigJson: TopupConfig | null };
  beneficiary: { id: string } | null;
  recentFires: Array<{
    counterpartyId: string;
    metaAdAccountId: string;
    decision: string;
    amount: number | string | { toString(): string };
    /**
     * Currency the persisted `amount` is denominated in (the fire's own
     * rail). REQUIRED, deliberately not optional-with-a-default: the
     * per-agency daily cap (gate 7) is denominated in ONE rail's currency,
     * so a fire whose currency is unknown cannot be summed into it safely.
     * A permissive default is exactly how the cross-currency cap bug
     * survived — an omitted field must be a type error, not a guess.
     */
    currency: string;
    firedAt: Date;
    /**
     * Status of the linked AirwallexPayout (when one exists).
     * Used to count "SKIPPED-with-money-actually-moving" rows for
     * cooldown/cap purposes. A manual fire whose submit threw mid-
     * flight is decision=SKIPPED reason=manual_submit_failed but
     * may have a real Payout that the reconciler later settles.
     * Without this we'd double-fire on cooldown.
     */
    payoutStatus?: string | null;
  }>;
  nowCet: Date;
  killSwitch: boolean;
  whatsappAdAccountCode?: string | null;
  burn?: { avgDailySpendNative: number; spendCoverageDays: number; daysOfRunway: number };
  treasury?: {
    airwallexAvailableHkd: number;
    pendingShopifyInflowHkd: number;
    pendingOutflowHkd: number;
    safetyReserveHkd: number;
    fxRateEurHkd: number;
  };
  inTickCommittedHkd?: number;
  rollingDailyTotalHkd?: number;
  rollingWeeklyTotalHkd?: number;
  perAccountOverrides?: {
    triggerDays?: number | null;
    targetRunwayDays?: number | null;
    minTopupEur?: number | null;
    maxTopupPerFireEur?: number | null;
  };
}

export type SkipReason =
  | "kill_switch"
  | "no_beneficiary"
  | "no_config"
  | "outside_window"
  | "cooldown"
  | "daily_cap"
  | "banned_word"
  | "remaining_above_threshold"
  | "insufficient_spend_coverage"
  | "insufficient_treasury"
  | "tick_cumulative_cap"
  | "daily_cumulative_cap"
  | "weekly_cumulative_cap"
  | "hysteresis_buffer"
  | "burn_rate_insufficient"
  | "fx_unavailable";

export type TopupDecision =
  | { kind: "FIRE"; amount: number; currency: string; bankReference: string; whatsappLines: string[] }
  | { kind: "SKIP"; reason: SkipReason; detail: string };

function cetParts(d: Date): { dayToken: string; minutes: number } {
  // Europe/Berlin reflects CET / CEST automatically. We rely on the host's timezone DB.
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const wk = (parts.find((p) => p.type === "weekday")?.value ?? "").toUpperCase().slice(0, 3);
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { dayToken: wk, minutes: hh * 60 + mm };
}

function parseHhMm(s: string): number {
  const [h, m] = s.split(":").map((x) => Number(x));
  return h * 60 + m;
}

function fmtAmountComma(amount: number): string {
  return amount.toFixed(2).replace(".", ",");
}

export function decideTopup(input: TopupDecisionInput): TopupDecision {
  // Gate 1: kill switch
  if (input.killSwitch) {
    return { kind: "SKIP", reason: "kill_switch", detail: "AIRWALLEX_AUTOTOPUP_DISABLED=true" };
  }
  // Gate 2: no beneficiary
  if (!input.beneficiary) {
    return { kind: "SKIP", reason: "no_beneficiary", detail: `counterparty ${input.counterparty.id} has no active beneficiary` };
  }
  // Gate 3: no config
  const cfg = input.counterparty.topupConfigJson;
  if (!cfg) {
    return { kind: "SKIP", reason: "no_config", detail: `counterparty ${input.counterparty.id} has no topupConfigJson` };
  }

  // Gate A (v3 — NEW): burn_rate_insufficient
  // Only when burn provided AND remaining >= threshold (no absolute breach) AND
  // daysOfRunway >= triggerDays. This handles the case where burn-rate inclusion let an
  // above-threshold account into the loop but it actually shouldn't fire.
  if (input.burn && input.remaining >= input.threshold) {
    const triggerDays = input.perAccountOverrides?.triggerDays ?? TOPUP_DEFAULTS.TRIGGER_DAYS;
    if (input.burn.daysOfRunway >= triggerDays) {
      return {
        kind: "SKIP",
        reason: "burn_rate_insufficient",
        detail: `remaining ${input.remaining} >= threshold ${input.threshold} and daysOfRunway ${input.burn.daysOfRunway} >= triggerDays ${triggerDays}`,
      };
    }
  }

  // Gate 4 (existing): remaining_above_threshold (only when burn is NOT provided —
  // when burn is provided, burn_rate_insufficient is the authoritative gate for
  // above-threshold accounts; without burn data we fall back to the absolute check).
  if (!input.burn && input.remaining >= input.threshold) {
    return { kind: "SKIP", reason: "remaining_above_threshold", detail: `remaining ${input.remaining} >= threshold ${input.threshold}` };
  }

  // Gate B (v3 — NEW): insufficient_spend_coverage
  // Only when burn provided AND spendCoverageDays < MIN_SPEND_COVERAGE (5).
  if (input.burn && input.burn.spendCoverageDays < TOPUP_DEFAULTS.MIN_SPEND_COVERAGE) {
    return {
      kind: "SKIP",
      reason: "insufficient_spend_coverage",
      detail: `spendCoverageDays ${input.burn.spendCoverageDays} < MIN_SPEND_COVERAGE ${TOPUP_DEFAULTS.MIN_SPEND_COVERAGE}`,
    };
  }

  // Gate C (v3 — NEW): fx_unavailable
  // Only when treasury provided AND fxRateEurHkd missing or zero.
  if (input.treasury && (!input.treasury.fxRateEurHkd || input.treasury.fxRateEurHkd <= 0)) {
    return {
      kind: "SKIP",
      reason: "fx_unavailable",
      detail: `treasury.fxRateEurHkd is missing or zero (${input.treasury.fxRateEurHkd})`,
    };
  }

  // Gate D (v3 — NEW): hysteresis_buffer
  // Only when most recent FIRED row exists for this (counterpartyId, metaAdAccountId) AND
  // remaining < threshold × (cfg.recoveryBuffer ?? 1 + RECOVERY_BUFFER_PCT/100). Prevent flap.
  // Gating: applied only when the v3 input surface is in use — either cfg.recoveryBuffer is
  // explicitly set, OR any v3 input field (burn / treasury) is provided. Legacy call sites
  // that provide none of these fall through to existing cooldown semantics.
  const isV3Call =
    cfg.recoveryBuffer != null ||
    input.burn !== undefined ||
    input.treasury !== undefined ||
    input.inTickCommittedHkd !== undefined ||
    input.rollingDailyTotalHkd !== undefined ||
    input.rollingWeeklyTotalHkd !== undefined;
  if (isV3Call) {
    const lastFiredForThisAccount = input.recentFires
      .filter(
        (f) =>
          countsAsFired(f) &&
          f.counterpartyId === input.counterparty.id &&
          f.metaAdAccountId === input.metaAdAccountId,
      )
      .sort((a, b) => b.firedAt.getTime() - a.firedAt.getTime())[0];
    if (lastFiredForThisAccount) {
      const bufferMultiplier =
        cfg.recoveryBuffer ?? (1 + TOPUP_DEFAULTS.RECOVERY_BUFFER_PCT / 100);
      const recoveryThreshold = input.threshold * bufferMultiplier;
      if (input.remaining < recoveryThreshold) {
        return {
          kind: "SKIP",
          reason: "hysteresis_buffer",
          detail: `remaining ${input.remaining} < threshold ${input.threshold} × buffer ${bufferMultiplier} = ${recoveryThreshold} (last fire ${lastFiredForThisAccount.firedAt.toISOString()})`,
        };
      }
    }
  }

  // Step 3: Compute the recommended amount BEFORE treasury / cap gates that compare against it.
  //
  // Units / currency contract:
  //   * Dynamic path (burn + perAccountOverrides.targetRunwayDays set):
  //       raw = burn.avgDailySpendNative × targetRunwayDays − remaining
  //     avgDailySpendNative is the **ad account's native currency** (EUR for NOVA
  //     Cape Town PSM). minTopupEur / maxTopupPerFireEur defaults are EUR.
  //     So `amount` here is EUR. It must be FX-converted to `cfg.currency` (e.g.
  //     HKD) before being returned in a FIRE — otherwise submitPayout would send
  //     "2700 HKD" worth of money labelled as the dynamic amount (8.5× undersize).
  //   * Legacy path: `cfg.baseAmount` is already in `cfg.currency` (HKD on PSM),
  //     no conversion needed.
  const isDynamicAmount =
    input.burn != null && input.perAccountOverrides?.targetRunwayDays != null;
  let amount: number;
  if (isDynamicAmount) {
    // FX is REQUIRED on the dynamic path (we must convert EUR → cfg.currency for
    // both the FIRE return and the treasury/cap comparisons). If treasury is
    // missing, SKIP with fx_unavailable — better to defer than send an undersized
    // payout. This shouldn't happen in v3 flows; defensive.
    if (!input.treasury) {
      return {
        kind: "SKIP",
        reason: "fx_unavailable",
        detail: `dynamic amount sizing requires treasury.fxRateEurHkd, treasury not provided`,
      };
    }
    const targetRunwayDays = input.perAccountOverrides!.targetRunwayDays!;
    const minTopup =
      input.perAccountOverrides!.minTopupEur ?? TOPUP_DEFAULTS.MIN_TOPUP_EUR;
    const maxTopup =
      input.perAccountOverrides!.maxTopupPerFireEur ?? TOPUP_DEFAULTS.MAX_TOPUP_PER_FIRE_EUR;
    const raw = input.burn!.avgDailySpendNative * targetRunwayDays - input.remaining;
    amount = Math.max(minTopup, Math.min(raw, maxTopup));  // EUR
  } else {
    amount = cfg.baseAmount;  // already in cfg.currency
  }
  // Convert `amount` to the real HKD value of what we will actually send, for
  // the HKD-denominated treasury + cumulative-cap gates below.
  //
  //   - dynamic path: `amount` is EUR by documented contract → × fxRateEurHkd.
  //   - legacy path, HKD: already HKD, identity.
  //   - legacy path, anything else: REFUSE. decideTopup is pure and receives
  //     exactly one rate (fxRateEurHkd), so it cannot price an arbitrary
  //     currency and must not pretend to. The previous code multiplied a
  //     non-HKD amount by the EUR→HKD rate — for USD that is ~8.9 instead of
  //     ~7.8, about 14% high, which inflates the treasury requirement and
  //     skips affordable top-ups as "insufficient_treasury". Unreachable while
  //     the tick resolves defaultRail=HKD; refusing keeps it unreachable
  //     loudly. Enabling automatic non-HKD top-ups means adding a
  //     per-currency →HKD rate map to TopupDecisionInput — a deliberate
  //     change, not an accident.
  //   - no treasury: compare in native units (cross-currency caps not enforced).
  let amountHkd: number;
  if (!input.treasury) {
    amountHkd = amount;
  } else if (isDynamicAmount) {
    amountHkd = amount * input.treasury.fxRateEurHkd;
  } else if (cfg.currency === "HKD") {
    amountHkd = amount;
  } else {
    return {
      kind: "SKIP",
      reason: "fx_unavailable",
      detail: `cannot price ${cfg.currency} against HKD — the automated loop supports HKD only (add a per-currency rate map to enable ${cfg.currency})`,
    };
  }

  // Gate E (v3 — NEW): insufficient_treasury — with partial top-ups.
  // Only when treasury provided.
  if (input.treasury) {
    const inTickCommitted = input.inTickCommittedHkd ?? 0;
    const available =
      input.treasury.airwallexAvailableHkd +
      input.treasury.pendingShopifyInflowHkd -
      input.treasury.pendingOutflowHkd -
      input.treasury.safetyReserveHkd -
      inTickCommitted;
    if (available < amountHkd) {
      // Partial top-up (dynamic path only): if we can't send the full sized
      // amount but there's still enough above the safety reserve to cover the
      // per-fire minimum, fire what's available rather than skipping. The
      // reserve is already carved out of `available`, so this never dips below
      // it; it just stops an under-funded-but-non-empty wallet from starving
      // an account. The legacy path keeps all-or-nothing semantics.
      const minHkd = isDynamicAmount
        ? (input.perAccountOverrides?.minTopupEur ?? TOPUP_DEFAULTS.MIN_TOPUP_EUR) *
          input.treasury.fxRateEurHkd
        : amountHkd;
      if (isDynamicAmount && available >= minHkd) {
        amount = available / input.treasury.fxRateEurHkd; // clamp EUR amount
        amountHkd = available; // = amount × fx; keep the cap gates consistent
      } else {
        return {
          kind: "SKIP",
          reason: "insufficient_treasury",
          detail: `available ${available.toFixed(2)} HKD < amount ${amountHkd.toFixed(2)} HKD`,
        };
      }
    }
  }

  // Gate F (v3 — NEW): tick_cumulative_cap
  // Only when treasury + inTickCommittedHkd provided.
  if (input.treasury && input.inTickCommittedHkd != null) {
    const maxTickHkd = TOPUP_DEFAULTS.MAX_TICK_TOTAL_EUR * input.treasury.fxRateEurHkd;
    if (input.inTickCommittedHkd + amountHkd > maxTickHkd) {
      return {
        kind: "SKIP",
        reason: "tick_cumulative_cap",
        detail: `inTickCommitted ${input.inTickCommittedHkd.toFixed(2)} + this ${amountHkd.toFixed(2)} > MAX_TICK ${maxTickHkd.toFixed(2)} HKD`,
      };
    }
  }

  // Gate G (v3 — NEW): daily_cumulative_cap
  // Only when rollingDailyTotalHkd provided.
  if (input.rollingDailyTotalHkd != null && input.treasury) {
    const inTickCommitted = input.inTickCommittedHkd ?? 0;
    const maxDailyHkd = TOPUP_DEFAULTS.MAX_DAILY_TOTAL_EUR * input.treasury.fxRateEurHkd;
    if (input.rollingDailyTotalHkd + inTickCommitted + amountHkd > maxDailyHkd) {
      return {
        kind: "SKIP",
        reason: "daily_cumulative_cap",
        detail: `rollingDaily ${input.rollingDailyTotalHkd.toFixed(2)} + inTick ${inTickCommitted.toFixed(2)} + this ${amountHkd.toFixed(2)} > MAX_DAILY ${maxDailyHkd.toFixed(2)} HKD`,
      };
    }
  }

  // Gate H (v3 — NEW): weekly_cumulative_cap
  if (input.rollingWeeklyTotalHkd != null && input.treasury) {
    const inTickCommitted = input.inTickCommittedHkd ?? 0;
    const maxWeeklyHkd = TOPUP_DEFAULTS.MAX_WEEKLY_TOTAL_EUR * input.treasury.fxRateEurHkd;
    if (input.rollingWeeklyTotalHkd + inTickCommitted + amountHkd > maxWeeklyHkd) {
      return {
        kind: "SKIP",
        reason: "weekly_cumulative_cap",
        detail: `rollingWeekly ${input.rollingWeeklyTotalHkd.toFixed(2)} + inTick ${inTickCommitted.toFixed(2)} + this ${amountHkd.toFixed(2)} > MAX_WEEKLY ${maxWeeklyHkd.toFixed(2)} HKD`,
      };
    }
  }

  // Gate 5 (existing): outside_window
  const { dayToken, minutes } = cetParts(input.nowCet);
  const startM = parseHhMm(cfg.windowStartCet);
  const endM = parseHhMm(cfg.windowEndCet);
  if (!cfg.windowDays.includes(dayToken) || minutes < startM || minutes > endM) {
    return {
      kind: "SKIP",
      reason: "outside_window",
      detail: `${dayToken} ${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")} CET vs ${cfg.windowDays.join(",")} ${cfg.windowStartCet}-${cfg.windowEndCet}`,
    };
  }

  // Gate 6 (existing): cooldown
  const cooldownMs = cfg.cooldownHours * 3600 * 1000;
  const lastFireSameAccount = input.recentFires
    .filter((f) => countsAsFired(f) && f.metaAdAccountId === input.metaAdAccountId)
    .sort((a, b) => b.firedAt.getTime() - a.firedAt.getTime())[0];
  if (lastFireSameAccount && input.nowCet.getTime() - lastFireSameAccount.firedAt.getTime() < cooldownMs) {
    return { kind: "SKIP", reason: "cooldown", detail: `last fire ${lastFireSameAccount.firedAt.toISOString()} within ${cfg.cooldownHours}h` };
  }

  // The FIRE amount in cfg.currency. The dynamic path computed `amount` in EUR; convert
  // to cfg.currency via fxRateEurHkd. The legacy path's cfg.baseAmount is already
  // in cfg.currency, no conversion needed.
  //
  // Without this conversion, submitPayout would send a HKD-labelled value equal to
  // the EUR figure (e.g. 2700 HKD ≈ €317 instead of €2700 ≈ HK$22,950) — an 8.5×
  // undersize on the NOVA Cape Town PSM account.
  const fireAmount = isDynamicAmount
    ? amount * input.treasury!.fxRateEurHkd
    : cfg.baseAmount;

  // Gate 7 (existing): daily_cap (per-counterparty, cfg.currency units).
  // `cfg.dailyCapAmount` belongs to the RESOLVED RAIL and is denominated in
  // that rail's own currency, so only fires on the same rail may be summed
  // into it. Since multi-rail agencies exist (PSM sends HKD and USD), a
  // persisted f.amount is in the fire's OWN currency — not necessarily
  // cfg.currency — and mixing them both overstated the HKD total with USD
  // figures and let real 24h outflow exceed the cap (two 640 USD manual
  // sends ≈ 9,984 HKD counted as 1,280 against a 10,000 HKD/day cap).
  // Cross-currency exposure is bounded separately by the HKD-denominated
  // rolling cumulative caps (gates G/H). Use fireAmount — the cfg.currency
  // value — for consistency on both paths.
  const dayMs = 24 * 3600 * 1000;
  const firedInLast24h = input.recentFires.filter((f) =>
    countsAsFired(f) &&
    f.currency.trim().toUpperCase() === cfg.currency.trim().toUpperCase() &&
    input.nowCet.getTime() - f.firedAt.getTime() < dayMs,
  );
  const firedTotalLast24h = firedInLast24h.reduce((s, f) => s + Number(f.amount.toString()), 0);
  if (firedTotalLast24h + fireAmount > cfg.dailyCapAmount) {
    return { kind: "SKIP", reason: "daily_cap", detail: `last-24h total ${firedTotalLast24h} + this ${fireAmount} > cap ${cfg.dailyCapAmount}` };
  }

  // Gate 8 (existing): banned_word
  const refLower = cfg.bankReference.toLowerCase();
  const banned = cfg.bannedReferenceWords.find((w) => refLower.includes(w.toLowerCase()));
  if (banned) {
    return { kind: "SKIP", reason: "banned_word", detail: `bankReference "${cfg.bankReference}" contains banned token "${banned}"` };
  }
  const whatsappLines = [
    input.whatsappAdAccountCode ?? input.metaAdAccountId,
    `Topup ${fmtAmountComma(fireAmount)} ${cfg.currency}`,
    `Payer name: ${cfg.payerName}`,
  ];

  return {
    kind: "FIRE",
    amount: fireAmount,
    currency: cfg.currency,
    bankReference: cfg.bankReference,
    whatsappLines,
  };
}
