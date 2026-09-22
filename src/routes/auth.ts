import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { one, serialize } from "../db.js";
import { issueSession, verifyAppleToken, requireUserId } from "../auth.js";
import { badRequest, conflict, notFound, unauthorized } from "../errors.js";

const bodySchema = z.object({
  identity_token: z.string().optional(),
  dev_user: z.string().optional(),
  handle: z.string().min(1).max(30).optional(),
});

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/apple", async (req) => {
    const body = bodySchema.parse(req.body ?? {});

    let appleSub: string;
    let appleEmail: string | undefined;
    if (body.dev_user && config.AUTH_DEV_BYPASS) {
      appleSub = `dev:${body.dev_user}`;
    } else if (body.identity_token) {
      ({ sub: appleSub, email: appleEmail } = await verifyAppleToken(body.identity_token));
    } else {
      throw badRequest("identity_token or dev_user required");
    }

    // Upsert the user by their Apple subject.
    let user = await one<any>("SELECT * FROM users WHERE apple_sub = $1", [appleSub]);
    if (!user) {
      user = await one<any>(
        "INSERT INTO users (apple_sub, email) VALUES ($1, $2) RETURNING *",
        [appleSub, appleEmail ?? null]
      );
    } else if (appleEmail && !user.email) {
      // Apple only sends email on first authorization — capture it if we didn't
      // have it (e.g. the user existed before we started storing email).
      user = await one<any>(
        "UPDATE users SET email = $2 WHERE id = $1 RETURNING *",
        [user.id, appleEmail]
      );
    }

    // Set the handle on first run if provided and free.
    if (body.handle && !user.handle) {
      const taken = await one("SELECT 1 FROM users WHERE handle = $1 AND id <> $2", [
        body.handle,
        user.id,
      ]);
      if (taken) throw conflict("handle_taken");
      user = await one<any>(
        "UPDATE users SET handle = $2 WHERE id = $1 RETURNING *",
        [user.id, body.handle]
      );
    }

    if (!user) throw unauthorized();
    const token = await issueSession(user.id);
    return {
      token,
      user: serialize.user(user),
      needs_handle: user.handle == null,
    };
  });

  // The authenticated user — fetched on app launch so the client always knows
  // who it is (its own id, for ownership checks) even after a relaunch.
  app.get("/me", async (req) => {
    const userId = await requireUserId(req);
    const user = await one<any>("SELECT * FROM users WHERE id = $1", [userId]);
    if (!user) throw notFound();
    return serialize.user(user);
  });

  // Set / change the current user's handle.
  app.post("/me/handle", async (req) => {
    const userId = await requireUserId(req);
    const { handle } = z.object({ handle: z.string().min(1).max(30) }).parse(req.body ?? {});
    const taken = await one("SELECT 1 FROM users WHERE handle = $1 AND id <> $2", [handle, userId]);
    if (taken) throw conflict("handle_taken");
    const user = await one<any>(
      "UPDATE users SET handle = $2 WHERE id = $1 RETURNING *",
      [userId, handle]
    );
    if (!user) throw notFound();
    return serialize.user(user);
  });
}
