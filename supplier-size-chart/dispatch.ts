// Dispatch + reminder loop for supplier size-chart requests. Driven by the
// worker tick (see worker.ts `startSupplierSizeChartTick`):
//   1. `needed` (and `request_failed`, so a transient send failure
//      self-heals) rows get a fresh portal link + Discord ping, then flip
//      to `requested`.
//   2. `requested` rows past the reminder interval (and under the reminder
//      cap) get a reminder ping and their counter bumped.
// See Task 11 (src/lib/supplier-size-chart/discord.ts) for the send, and
// Task 5 (./token.ts) for the portal token.
import prisma from "@/lib/db";
import { sendSupplierSizeChartRequest } from "./discord";
import { resolveOurProductUrl } from "./product-url";
import { buildItemPortalUrl, buildListPortalUrl } from "./links";
import { getDispatchSettings, getListTokenVersion } from "./settings";
import { filterKeysWithActiveSeller } from "./active-seller";

/** Max rows processed per pass, per stage - keeps a single tick bounded. */
const BATCH_SIZE = 25;

/**
 * Drop rows for items no live store sells any more, so a retired store's dead
 * catalog stops generating supplier pings. Applied to first sends AND reminders
 * — rows opened before a store retired are already in `requested`, and those
 * are precisely the ones that keep nagging.
 *
 * Skipping (rather than flipping state) is deliberate: nothing is lost, and
 * un-retiring a store resumes its chases on the next tick with no repair step.
 */
async function dropDeadStock<T extends { id: string; sourceKey: string; title: string | null }>(
  rows: T[],
  stage: string,
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const active = await filterKeysWithActiveSeller(rows.map((r) => r.sourceKey));
  const kept = rows.filter((r) => active.has(r.sourceKey));
  const dropped = rows.filter((r) => !active.has(r.sourceKey));
  if (dropped.length > 0) {
    console.log(
      `[supplier-size-chart] ${stage}: skipped ${dropped.length} row(s) with no active seller (retired/deleted store): ` +
        dropped.map((r) => `${r.id}${r.title ? ` "${r.title}"` : ""}`).join(", "),
    );
  }
  return kept;
}

export async function dispatchPendingSupplierCharts(): Promise<{ dispatched: number; reminded: number; failed: number }> {
  const cfg = await getDispatchSettings();
  if (!cfg.enabled) return { dispatched: 0, reminded: 0, failed: 0 };

  const allPendingUrl = buildListPortalUrl(await getListTokenVersion());

  let dispatched = 0;
  let reminded = 0;
  let failed = 0;

  // 1) First send for rows that have never been requested, plus rows whose
  // prior send attempt failed transiently (Discord blip, etc.) - re-picking
  // `request_failed` here lets those self-heal on a later tick instead of
  // being orphaned forever.
  const needed = await dropDeadStock(
    await prisma.supplierSizeChart.findMany({
      where: { state: { in: ["needed", "request_failed"] } },
      take: BATCH_SIZE,
    }),
    "dispatch",
  );
  for (const sc of needed) {
    let discordMessageId: string | undefined;
    try {
      ({ discordMessageId } = await sendSupplierSizeChartRequest({
        scId: sc.id,
        productName: sc.title ?? "your product",
        productImageUrl: sc.imageUrl ?? undefined,
        productUrl: (await resolveOurProductUrl(sc.sampleProductId)) ?? undefined,
        portalUrl: buildItemPortalUrl(sc.id, sc.tokenVersion),
        allPendingUrl,
        reminder: undefined,
      }));
    } catch (e) {
      failed++;
      await prisma.supplierSizeChart
        .update({ where: { id: sc.id }, data: { state: "request_failed", publishError: (e as Error).message.slice(0, 300) } })
        .catch(() => {});
      continue;
    }

    // Send succeeded. The state flip is a separate failure mode: if it
    // throws (e.g. a transient DB blip), the supplier has already been
    // messaged, so we must NOT mark this row request_failed - that would
    // permanently mislabel it and nothing would ever chase it again. Leave
    // it in `needed` so the next tick retries (a rare duplicate ping is
    // acceptable; a permanent mislabel is not).
    try {
      await prisma.supplierSizeChart.update({
        where: { id: sc.id },
        data: { state: "requested", requestedAt: new Date(), requestMessageId: discordMessageId, lastReminderAt: new Date() },
      });
      dispatched++;
    } catch (e) {
      failed++;
      console.error(
        `[supplier-size-chart] orphaned dispatch for scId=${sc.id}: Discord message ${discordMessageId} sent but state flip to "requested" failed: ${(e as Error).message}`,
      );
    }
  }

  // 2) Reminders for requested rows past the interval and under the cap.
  const cutoff = new Date(Date.now() - cfg.reminderIntervalMs);
  const due = await dropDeadStock(
    await prisma.supplierSizeChart.findMany({
      where: {
        state: "requested",
        reminderCount: { lt: cfg.maxReminders },
        OR: [{ lastReminderAt: { lte: cutoff } }, { lastReminderAt: null }],
      },
      take: BATCH_SIZE,
    }),
    "reminder",
  );
  for (const sc of due) {
    try {
      await sendSupplierSizeChartRequest({
        scId: sc.id,
        productName: sc.title ?? "your product",
        productImageUrl: sc.imageUrl ?? undefined,
        productUrl: (await resolveOurProductUrl(sc.sampleProductId)) ?? undefined,
        portalUrl: buildItemPortalUrl(sc.id, sc.tokenVersion),
        allPendingUrl,
        reminder: true,
      });
      await prisma.supplierSizeChart.update({
        where: { id: sc.id },
        data: { reminderCount: sc.reminderCount + 1, lastReminderAt: new Date() },
      });
      reminded++;
    } catch {
      failed++;
    }
  }

  return { dispatched, reminded, failed };
}
