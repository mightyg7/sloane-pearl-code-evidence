/**
 * Meta Ads — ABO kill rules (per AD SET, not per campaign).
 *
 * The main engine (auto-kill.ts) pauses a whole CAMPAIGN. On an ABO launch
 * that stops every angle at once, which ends the test instead of pruning the
 * loser — the opposite of what ABO is for. These rules judge each ad set (=
 * one pain-point angle) on its own, so the losers stop and the winners keep
 * spending.
 *
 * Thresholds are USD (same convention as auto-kill.ts). They are NOT guesses
 * — each one is calibrated against 180 days / 113 campaigns on the live
 * account, with the top 5 by spend (43% of all spend) broken down day by day
 * and ad set by ad set:
 *
 *   1. COST PER VISITOR (abo_cpv) — $6.
 *      Real cost per visitor across every campaign with ≥20 visitors:
 *        min $0.81 · median $2.05 · p90 $3.51 · MAX $5.17
 *      No campaign in 180 days has ever crossed $6. The 27/7 ABO launch sat
 *      at $7.25. This is an "delivery is broken" alarm, not a quality score
 *      — see the warning below.
 *
 *   2. NO CARTS (abo_no_cart) — 30 visitors.
 *      Of 21 campaigns that ever made a sale, 21 had add-to-carts first.
 *      Zero exceptions. Three campaigns reached 30+ visitors with no cart;
 *      none of them ever sold. Carts run ~3.8x more frequent than sales, so
 *      this fires far earlier and cheaper than any sale-based rule.
 *
 *   3. NO SALES (abo_no_sale) — 150 visitors.
 *      Backstop for the "carts but never converts" case (broken checkout,
 *      bad price). Set above the worst observed visitors-before-first-sale
 *      among winners: the Oona campaign took ~125 visitors and 3 days to
 *      make its first sale. A 104 threshold — the naive read of "worst
 *      visitors-per-sale" — would have killed it just before it converted.
 *
 *   4. NO SALES BY SPEND (abo_no_sale_spend) — 3x the ad set's daily budget.
 *      Rule 3 is expressed in VISITORS, which silently assumes traffic shows
 *      up. It does not on a small ABO ad set: the 27/7 launch's surviving
 *      angle drew ~12 visitors/day on €41/day, putting the 150-visitor
 *      checkpoint ~12 days and ~€500 away while it sat at 0 sales — and the
 *      other two rules could never reach it (cheap enough to clear the cost
 *      gate, and 2 carts permanently rules out rule 2). Money is the only
 *      dimension that always moves, so this backstop is denominated in it.
 *      3x, not 2x: the Oona campaign did not make its first sale until
 *      ~$198 against a ~$97/day budget, and 2x ($194) would have killed it
 *      just before it converted. Guarded by a test.
 *      Evaluated BEFORE rule 3 — on a low-traffic ad set it is the one that
 *      actually fires, and its reason names the real cause (money spent),
 *      not an unreachable visitor count.
 *
 * WARNING, do not "improve" rule 1 into a ranking: cheap visitors are NOT
 * better visitors on this account. The best campaign (Matching Sets, 1.84
 * ROAS) had the MOST expensive traffic at $2.39/visitor and converted 1 in
 * 22; the cheapest traffic ($0.81/visitor) converted 1 in 104. Cost per
 * visitor only separates "broken" from "working", never "better" from
 * "worse".
 */

/** One ad set's numbers for the evaluation window. Spend is USD. */
export interface AboAdSetStats {
  adSetId: string;
  adSetName: string;
  spendUsd: number;
  /** Meta `landing_page_view` — people who actually reached the page. */
  visitors: number;
  /** Meta `add_to_cart` (omni-preferred, see insights.ts parseActions). */
  carts: number;
  purchases: number;
  /** The ad set's own daily budget in USD. Absent when Meta reports no
   *  `daily_budget` — a lifetime-budget ad set is the real case — and the
   *  spend backstop then has no budget to scale against, so it is skipped
   *  rather than guessed. */
  dailyBudgetUsd?: number;
}

export interface AboKillRules {
  /** Master switch for the whole ABO lane. Off = ABO campaigns are skipped. */
  aboEnabled: boolean;
  aboCpvEnabled: boolean;
  /** Don't judge cost per visitor below this spend — too noisy. USD. */
  aboCpvSpendMin: number;
  /** Kill above this cost per visitor. USD. */
  aboCpvMax: number;
  aboNoCartEnabled: boolean;
  aboNoCartVisitors: number;
  aboNoSaleEnabled: boolean;
  aboNoSaleVisitors: number;
  aboNoSaleSpendEnabled: boolean;
  /** Multiple of the ad set's DAILY budget at which a no-sale angle dies. */
  aboNoSaleSpendMultiple: number;
}

export const ABO_KILL_DEFAULTS: AboKillRules = {
  aboEnabled: true,
  aboCpvEnabled: true,
  aboCpvSpendMin: 22,   // ≈ €20
  aboCpvMax: 6,         // ≈ €5.50; observed max ever $5.17
  aboNoCartEnabled: true,
  aboNoCartVisitors: 30,
  aboNoSaleEnabled: true,
  aboNoSaleVisitors: 150,
  aboNoSaleSpendEnabled: true,
  aboNoSaleSpendMultiple: 3,
};

export type AboKillRuleName = "abo_cpv" | "abo_no_cart" | "abo_no_sale" | "abo_no_sale_spend";

export type AboVerdict =
  | { kill: false; reason: string }
  | {
      kill: true;
      rule: AboKillRuleName;
      metricName: string;
      metricValue: number;
      thresholdDesc: string;
    };

/**
 * Cost per visitor. Spending real money while producing ZERO visitors is the
 * worst case, not an undefined one — it is exactly how the 27/7 launch failed
 * (€84 for 9 visitors). Report it as Infinity so rule 1 catches it instead of
 * dividing by zero and passing.
 */
export function costPerVisitor(spendUsd: number, visitors: number): number {
  if (visitors > 0) return spendUsd / visitors;
  return spendUsd > 0 ? Infinity : 0;
}

/**
 * Decide one ad set's fate. Pure — no I/O, no clock. Order matters:
 * a purchase is total immunity, then delivery, then the funnel gates.
 */
export function evaluateAboAdSet(s: AboAdSetStats, r: AboKillRules): AboVerdict {
  if (!r.aboEnabled) return { kill: false, reason: "ABO rules disabled" };

  // Rule 0 — a sale buys immunity, same as the campaign-level engine.
  if (s.purchases > 0) {
    return { kill: false, reason: `${s.purchases} sale(s) — immune` };
  }

  const cpv = costPerVisitor(s.spendUsd, s.visitors);

  // Rule 1 — delivery. Fires within ~20 minutes on a broken ad set.
  if (r.aboCpvEnabled && s.spendUsd >= r.aboCpvSpendMin && cpv > r.aboCpvMax) {
    return {
      kill: true,
      rule: "abo_cpv",
      metricName: "Cost per visitor",
      metricValue: Number.isFinite(cpv) ? Number(cpv.toFixed(2)) : 0,
      thresholdDesc: Number.isFinite(cpv)
        ? `$${cpv.toFixed(2)}/visitor at $${s.spendUsd.toFixed(2)} spend (max $${r.aboCpvMax})`
        : `$${s.spendUsd.toFixed(2)} spend, 0 visitors`,
    };
  }

  // Rule 2 — no carts. The strongest early signal in the account's history.
  if (r.aboNoCartEnabled && s.visitors >= r.aboNoCartVisitors && s.carts === 0) {
    return {
      kill: true,
      rule: "abo_no_cart",
      metricName: "Carts",
      metricValue: 0,
      thresholdDesc: `${s.visitors} visitors, 0 carts (min ${r.aboNoCartVisitors})`,
    };
  }

  // Rule 4 — spend backstop. The one that actually fires on a low-traffic
  // ABO ad set, where rule 3's visitor checkpoint is effectively unreachable.
  if (
    r.aboNoSaleSpendEnabled &&
    s.dailyBudgetUsd != null &&
    s.dailyBudgetUsd > 0 &&
    s.spendUsd >= r.aboNoSaleSpendMultiple * s.dailyBudgetUsd &&
    s.purchases === 0
  ) {
    const cap = r.aboNoSaleSpendMultiple * s.dailyBudgetUsd;
    return {
      kill: true,
      rule: "abo_no_sale_spend",
      metricName: "Purchases",
      metricValue: 0,
      thresholdDesc: `$${s.spendUsd.toFixed(2)} spend, 0 sales — over ${r.aboNoSaleSpendMultiple}x the $${s.dailyBudgetUsd.toFixed(2)}/day budget ($${cap.toFixed(2)})`,
    };
  }

  // Rule 3 — carts but never converts. Rarely fires; rule 2 catches most.
  if (r.aboNoSaleEnabled && s.visitors >= r.aboNoSaleVisitors && s.purchases === 0) {
    return {
      kill: true,
      rule: "abo_no_sale",
      metricName: "Purchases",
      metricValue: 0,
      thresholdDesc: `${s.visitors} visitors, ${s.carts} carts, 0 sales (min ${r.aboNoSaleVisitors})`,
    };
  }

  return {
    kill: false,
    reason: `passed at $${s.spendUsd.toFixed(2)} · ${s.visitors} visitors · ${s.carts} carts`,
  };
}
