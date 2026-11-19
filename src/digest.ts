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
const SEND_HOUR_LOCAL = 9;                // Sunday ~9am in the user's own time zone
const MIN_TITLES = 2;                     // nothing worth a "revisit these" below this

/** The wall clock in `timeZone` at `now` — weekday (0 = Sunday), hour, and the
 *  local calendar date. Unknown or missing zones fall back to UTC. */
export function localClock(now: Date, timeZone: string | null | undefined): { weekday: number; hour: number; date: string } {
  let zone = timeZone || "UTC";
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, weekday: "short", hour: "2-digit", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(now);
  } catch {
    zone = "UTC";
    return localClock(now, zone);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { weekday, hour: Number(get("hour")), date: `${get("year")}-${get("month")}-${get("day")}` };
}

/** Whether it's digest time (Sunday, the send hour) in this zone; returns the
 *  local Sunday's date — the week this digest belongs to — or null. */
export function digestWeek(now: Date, timeZone: string | null | undefined): string | null {
  const local = localClock(now, timeZone);
  return local.weekday === 0 && local.hour === SEND_HOUR_LOCAL ? local.date : null;
}

/** Build the notification body from a user's recent save titles. */
function digestBody(titles: string[]): string {
  const shown = titles.slice(0, 2);
  const more = titles.length - shown.length;
  const list = shown.join(", ");
  return more > 0 ? `${list} and ${more} more` : list;
}

/** Run one digest sweep for the given moment. Exported for testing. Returns the
 *  number of users actually pushed to. Safe to call repeatedly: each user is
 *  sent at most once per week, when it's Sunday morning where they are. */
export async function runDigestSweep(now: Date): Promise<number> {
  if (!pushEnabled) return 0;

  // Everyone with a registered device, with the zone of their latest device.
  const users = await q<{ user_id: string; time_zone: string | null }>(
    `SELECT DISTINCT ON (user_id) user_id, time_zone FROM device_tokens
     ORDER BY user_id, updated_at DESC`
  );

  let sent = 0;
  for (const { user_id, time_zone } of users) {
    const week = digestWeek(now, time_zone);
    if (!week) continue;
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
      { type: "digest" },
      { kind: "digest" }
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
