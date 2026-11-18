import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q } from "../db.js";
import { requireUserId } from "../auth.js";

export async function devicesRoutes(app: FastifyInstance) {
  // POST /devices — register/refresh this device's APNs token for the user.
  app.post("/devices", async (req) => {
    const userId = await requireUserId(req);
    const { token, time_zone } = z
      .object({ token: z.string().min(1), time_zone: z.string().min(1).max(64).optional() })
      .parse(req.body ?? {});
    // Older app builds don't send a time zone — keep whatever we already know.
    await q(
      `INSERT INTO device_tokens (token, user_id, time_zone, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id,
         time_zone = COALESCE(EXCLUDED.time_zone, device_tokens.time_zone), updated_at = now()`,
      [token, userId, time_zone ?? null]
    );
    return { ok: true };
  });

  // DELETE /devices/:token — deregister (e.g. on sign-out).
  app.delete("/devices/:token", async (req, reply) => {
    const userId = await requireUserId(req);
    const { token } = req.params as { token: string };
    await q("DELETE FROM device_tokens WHERE token = $1 AND user_id = $2", [token, userId]);
    reply.code(204);
    return null;
  });
}
