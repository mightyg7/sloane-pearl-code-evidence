import prisma from "@/lib/db";
import { normalizeSourceKey } from "./source-key";
import { ensureNeeded } from "./repository";
import { isStoreRetired } from "./active-seller";

/**
 * Called (fire-and-forget) after a paid order persists. For each sold product,
 * map it to its supplier item (via sourceUrl) and ensure a size-chart request
 * exists. If a chart is ALREADY published for that item, immediately mirror it
 * onto this (possibly new) store's product instead of re-asking the supplier.
 * Never throws — the caller must not have order ingestion affected by this.
 */
export async function onProductsSold(input: {
  connectedStoreId: string;
  shopifyProductIds: string[];
}): Promise<void> {
  const ids = [...new Set(input.shopifyProductIds.filter(Boolean).map(String))];
  if (ids.length === 0) return;

  // A retired store can still take a straggler order (an in-flight checkout, a
  // manual/test order). Its catalog is dead stock, so never open a supplier
  // chase off it — the supplier would be asked for a chart nothing publishes to.
  if (await isStoreRetired(input.connectedStoreId)) return;

  const products = await prisma.shopifyProduct.findMany({
    where: { storeId: input.connectedStoreId, shopifyProductId: { in: ids } },
    select: { id: true, storeId: true, shopifyProductId: true, sourceUrl: true, title: true },
  });

  for (const p of products) {
    const sourceKey = normalizeSourceKey(p.sourceUrl);
    if (!sourceKey) continue; // no cross-store identity; skip (v1)
    try {
      const res = await ensureNeeded({
        sourceKey,
        sampleProductId: p.id,
        title: p.title ?? undefined,
      });
      if (res.state === "published") {
        // A new store started selling an item we already have a chart for:
        // publish the existing blob straight onto this product.
        const { publishSourceKeyToProduct } = await import("./publish");
        await publishSourceKeyToProduct({ sourceKey, shopifyProductId: p.id });
      }
    } catch (err) {
      console.error(`[supplier-size-chart:trigger] product=${p.id} sourceKey=${sourceKey}:`, err);
    }
  }
}
