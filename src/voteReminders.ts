// "Voting closes soon" — a nudge to the members of a shared board who haven't
// voted yet, a couple of hours before the board's vote deadline (decide_by).
//
// Each board is claimed atomically (decide_reminded_for = decide_by) before
// anyone is notified, so overlapping sweeps can't double-send, and a new
// deadline gets its own reminder. A deadline set only moments ago is skipped —
// a one-hour vote shouldn't open with a "closes soon" buzz.

import { q } from "./db.js";
import { notifyUser, pushEnabled } from "./push.js";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
/** How far ahead of the deadline to remind. */
export const REMIND_BEFORE_MS = 2 * 60 * 60 * 1000;
/** Don't remind about a deadline that was set (or changed) this recently. */
const MIN_SINCE_SET_MS = 30 * 60 * 1000;

/** "in 2 hours" / "in 1 hour" / "in 40 minutes" for the time left. */
export function closingPhrase(msLeft: number): string {
  const minutes = Math.max(1, Math.round(msLeft / 60_000));
  if (minutes >= 90) return `in ${Math.round(minutes / 60)} hours`;
  if (minutes >= 55) return "in 1 hour";
  return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** One sweep. Returns how many people were reminded. Safe to call repeatedly.
 *  `notify` / `enabled` are injectable for tests. */
export async function runVoteReminderSweep(
  now: Date,
  notify: typeof notifyUser = notifyUser,
  enabled: boolean = pushEnabled
): Promise<number> {
  if (!enabled) return 0;
  const boards = await q<{ id: string; name: string; decide_by: Date }>(
    `UPDATE boards SET decide_reminded_for = decide_by
     WHERE decide_by IS NOT NULL AND decided_card_id IS NULL
       AND decide_by > $1 AND decide_by <= $1::timestamptz + ($2 || ' milliseconds')::interval
       AND decide_reminded_for IS DISTINCT FROM decide_by
       AND updated_at <= $1::timestamptz - ($3 || ' milliseconds')::interval
     RETURNING id, name, decide_by`,
    [now.toISOString(), String(REMIND_BEFORE_MS), String(MIN_SINCE_SET_MS)]
  );

  let reminded = 0;
  for (const board of boards) {
    // Members who haven't backed any card on this board yet.
    const people = await q<{ user_id: string }>(
      `SELECT bm.user_id FROM board_members bm
       WHERE bm.board_id = $1 AND NOT EXISTS (
         SELECT 1 FROM card_votes v JOIN cards c ON c.id = v.card_id
         WHERE c.board_id = $1 AND v.user_id = bm.user_id
       )`,
      [board.id]
    );
    const when = closingPhrase(new Date(board.decide_by).getTime() - now.getTime());
    for (const { user_id } of people) {
      const ok = await notify(
        user_id,
        board.name,
        `Voting closes ${when} — you haven’t voted yet. Back your favourite.`,
        { type: "vote", board_id: board.id },
        { timeSensitive: true }
      );
      if (ok) reminded++;
    }
  }
  return reminded;
}

export function startVoteReminderWorker(): NodeJS.Timeout {
  return setInterval(() => {
    runVoteReminderSweep(new Date()).catch((err) =>
      console.error("[vote-reminders] sweep failed:", (err as Error).message)
    );
  }, CHECK_INTERVAL_MS).unref();
}
