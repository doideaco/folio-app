// Price-watch. Periodically re-checks saved product cards and, when a price
// drops or a sold-out item comes back, updates the card, appends a price-history
// point (so the card can show "was £X"), and notifies the owner.
//
// Like the digest, there's no cron infra: we poll on an interval. Each card
// carries `last_price_checked_at` so re-fetches are paced (never more than once
// per RECHECK_AFTER) and the oldest are checked first. The card update happens
// regardless of push being configured — the drop still shows in-app / on the
// wishlist; the notification is best-effort on top.

import { q } from "./db.js";
import { notifyUser } from "./push.js";
import { refetchProduct } from "./extraction.js";

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // poll every 15 minutes
const RECHECK_AFTER = "12 hours";         // don't re-fetch a card more often than this
const BATCH = 20;                         // cards per sweep
const HISTORY_CAP = 20;

/** A price string like "£24.00" / "24.00" / "1,299.00 GBP" → a number, or null. */
function parseMoney(s?: string | null): number | null {
  if (!s) return null;
  const m = String(s).replace(/[, ]/g, "").match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

/** Run one price sweep for the given moment. Exported for testing. Returns the
 *  number of cards whose price/availability actually changed. */
export async function runPriceSweep(now: Date): Promise<number> {
  const rows = await q<{ id: string; added_by: string; title: string | null; extracted: any }>(
    `SELECT id, added_by, title, extracted FROM cards
      WHERE status = 'ready' AND extracted->>'kind' = 'product'
        AND (last_price_checked_at IS NULL
             OR last_price_checked_at < now() - interval '${RECHECK_AFTER}')
      ORDER BY last_price_checked_at ASC NULLS FIRST
      LIMIT ${BATCH}`
  );

  let changed = 0;
  for (const row of rows) {
    const product = row.extracted ?? {};
    const fresh = await refetchProduct(product).catch(() => null);
    // Always stamp the check so we pace re-fetches, even when a fetch failed.
    await q(`UPDATE cards SET last_price_checked_at = now() WHERE id = $1`, [row.id]);
    if (!fresh) continue;

    const oldPrice = parseMoney(product.price);
    const newPrice = parseMoney(fresh.price);
    const wasAvailable: boolean | null = product.available ?? null;
    const nowAvailable = fresh.available;

    const priceChanged = newPrice != null && newPrice !== oldPrice;
    // A string change also catches a currency relabel (e.g. a card saved before
    // the meta.json currency fix, "$40.00" → "£40.00") so old cards self-heal.
    const priceStringChanged = fresh.price != null && fresh.price !== product.price;
    const availChanged = nowAvailable != null && nowAvailable !== wasAvailable;
    if (!priceStringChanged && !availChanged) continue;

    // Merge the fresh fields into the stored product; append a history point.
    const next: any = { ...product };
    if (fresh.price != null) next.price = fresh.price;
    next.compare_at_price = fresh.compareAt ?? next.compare_at_price ?? null;
    if (fresh.available != null) next.available = fresh.available;
    if (Array.isArray(fresh.variants)) next.variants = fresh.variants;
    if (Array.isArray(fresh.options)) next.options = fresh.options;
    if (priceChanged && fresh.price != null) {
      const history = Array.isArray(product.price_history) ? product.price_history.slice() : [];
      history.push({ at: now.toISOString(), price: fresh.price });
      next.price_history = history.slice(-HISTORY_CAP);
    }
    await q(`UPDATE cards SET extracted = $2::jsonb, updated_at = now() WHERE id = $1`, [
      row.id, JSON.stringify(next),
    ]);
    changed++;

    const name = (row.title ?? next.title ?? "Your saved item").toString().trim().slice(0, 80);
    const priceDropped = oldPrice != null && newPrice != null && newPrice < oldPrice;
    const restocked = wasAvailable === false && nowAvailable === true;
    if (priceDropped) {
      void notifyUser(
        row.added_by, "Price drop",
        `${name} is now ${fresh.price}${product.price ? ` (was ${product.price})` : ""}`,
        { type: "price", card_id: row.id }
      );
    } else if (restocked) {
      void notifyUser(row.added_by, "Back in stock", `${name} is available again`,
        { type: "restock", card_id: row.id });
    }
  }
  return changed;
}

/** Start the polling worker. Returns the interval handle. */
export function startPriceWatchWorker(): NodeJS.Timeout {
  return setInterval(() => {
    runPriceSweep(new Date()).catch((err) =>
      console.error("[pricewatch] sweep failed:", (err as Error).message)
    );
  }, CHECK_INTERVAL_MS);
}
