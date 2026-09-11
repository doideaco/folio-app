// Weekly resurface digest. A gentle Sunday-morning nudge that summarises a few
// of the things you've saved — "Revisit these: …" — to pull your library back
// into view. No tried/untried framing; just a sample of your recent saves.
//
// There's no cron infra, so we poll on an interval and gate on the wall clock.
// Each (user, week) slot is claimed in `push_digests` BEFORE sending, so a
// double tick or a crash mid-sweep can never send the same digest twice.

import { q } from "./db.js";
import { notifyUser, pushEnabled } from "./push.js";

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes
const SEND_HOUR_UTC = 9;                  // Sunday ~9am (server/UTC time)
const MIN_TITLES = 2;                     // nothing worth a "revisit these" below this

/** The Sunday that starts `d`'s week, as an ISO date (YYYY-MM-DD, UTC). */
function weekStart(d: Date): string {
  const sunday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay()));
  return sunday.toISOString().slice(0, 10);
}

/** Build the notification body from a user's recent save titles. */
function digestBody(titles: string[]): string {
  const shown = titles.slice(0, 2);
  const more = titles.length - shown.length;
  const list = shown.join(", ");
  return more > 0 ? `${list} and ${more} more` : list;
}

/** Run one digest sweep for the given moment. Exported for testing. Returns the
 *  number of users actually pushed to. Safe to call repeatedly. */
export async function runDigestSweep(now: Date): Promise<number> {
  if (!pushEnabled) return 0;
  // Only fire during the 9am UTC hour on Sundays; other ticks are no-ops.
  if (now.getUTCDay() !== 0 || now.getUTCHours() !== SEND_HOUR_UTC) return 0;

  const week = weekStart(now);
  // Candidates: anyone with a registered device who hasn't got this week's yet.
  const candidates = await q<{ user_id: string }>(
    `SELECT DISTINCT dt.user_id FROM device_tokens dt
     WHERE NOT EXISTS (
       SELECT 1 FROM push_digests pd WHERE pd.user_id = dt.user_id AND pd.week = $1
     )`,
    [week]
  );

  let sent = 0;
  for (const { user_id } of candidates) {
    // Claim the slot first (idempotent). If we lose the race, skip.
    const claimed = await q(
      `INSERT INTO push_digests (user_id, week) VALUES ($1, $2)
       ON CONFLICT (user_id, week) DO NOTHING RETURNING user_id`,
      [user_id, week]
    );
    if (claimed.length === 0) continue;

    const rows = await q<{ title: string | null }>(
      `SELECT title FROM cards
       WHERE added_by = $1 AND status = 'ready'
       ORDER BY created_at DESC LIMIT 5`,
      [user_id]
    );
    const titles = rows.map((r) => (r.title ?? "").trim()).filter(Boolean);
    if (titles.length < MIN_TITLES) continue; // claimed the slot, but nothing to say

    const ok = await notifyUser(
      user_id,
      "Revisit your saves",
      `Revisit these: ${digestBody(titles)}`,
      { type: "digest" }
    );
    if (ok) sent++;
  }
  return sent;
}

/** Start the polling worker. Returns the interval handle. */
export function startDigestWorker(): NodeJS.Timeout {
  return setInterval(() => {
    runDigestSweep(new Date()).catch((err) =>
      console.error("[digest] sweep failed:", (err as Error).message)
    );
  }, CHECK_INTERVAL_MS);
}
