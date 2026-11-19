import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q } from "../db.js";
import { requireUserId } from "../auth.js";
import { forbidden } from "../errors.js";
import { isMember } from "./boards.js";
import { NOTIFICATION_KINDS } from "../push.js";

// The caller's notification settings: which kinds of push they've switched off
// (see NOTIFICATION_KINDS) and which boards they've muted. Honoured by
// notifyUser / notifyBoard for every push, however it's triggered.
export async function notificationsRoutes(app: FastifyInstance) {
  app.get("/me/notifications", async (req) => {
    const userId = await requireUserId(req);
    const [prefs] = await q<{ disabled: string[] }>(
      "SELECT disabled FROM notification_prefs WHERE user_id = $1", [userId]);
    const mutes = await q<{ board_id: string }>(
      "SELECT board_id FROM board_mutes WHERE user_id = $1 ORDER BY created_at", [userId]);
    return { disabled: prefs?.disabled ?? [], muted_board_ids: mutes.map((m) => m.board_id) };
  });

  app.put("/me/notifications", async (req) => {
    const userId = await requireUserId(req);
    const { disabled } = z
      .object({ disabled: z.array(z.enum(NOTIFICATION_KINDS)) })
      .parse(req.body ?? {});
    const unique = [...new Set(disabled)];
    await q(
      `INSERT INTO notification_prefs (user_id, disabled, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET disabled = EXCLUDED.disabled, updated_at = now()`,
      [userId, unique]
    );
    return { disabled: unique };
  });

  // Mute / unmute pushes about one board.
  app.put("/boards/:id/mute", async (req) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    if (!(await isMember(userId, id))) throw forbidden();
    await q(
      `INSERT INTO board_mutes (user_id, board_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, id]
    );
    return { board_id: id, muted: true };
  });

  app.delete("/boards/:id/mute", async (req) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    await q("DELETE FROM board_mutes WHERE user_id = $1 AND board_id = $2", [userId, id]);
    return { board_id: id, muted: false };
  });
}
