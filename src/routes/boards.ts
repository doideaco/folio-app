import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";
import { q, one, tx, serialize } from "../db.js";
import { requireUserId } from "../auth.js";
import { forbidden, notFound, badRequest } from "../errors.js";
import { notifyBoard } from "../push.js";

const createSchema = z.object({
  id: z.string().uuid().optional(), // client-generated id (idempotency key)
  name: z.string().min(1).max(80),
  emoji: z.string().max(8).optional(),
  kind: z.enum(["solo", "shared"]).default("solo"),
});

export async function isMember(userId: string, boardId: string): Promise<boolean> {
  const row = await one("SELECT 1 FROM board_members WHERE board_id = $1 AND user_id = $2", [
    boardId,
    userId,
  ]);
  return row != null;
}

export async function isOwner(userId: string, boardId: string): Promise<boolean> {
  const row = await one(
    "SELECT 1 FROM board_members WHERE board_id = $1 AND user_id = $2 AND role = 'owner'",
    [boardId, userId]
  );
  return row != null;
}

export async function boardsRoutes(app: FastifyInstance) {
  // GET /boards — boards + members + users for the current user.
  app.get("/boards", async (req) => {
    const userId = await requireUserId(req);
    const boards = await q<any>(
      `SELECT * FROM boards
       WHERE id IN (SELECT board_id FROM board_members WHERE user_id = $1)
       ORDER BY updated_at DESC`,
      [userId]
    );
    const boardIds = boards.map((b) => b.id);
    const members = boardIds.length
      ? await q<any>("SELECT * FROM board_members WHERE board_id = ANY($1::uuid[])", [boardIds])
      : [];
    const userIds = Array.from(new Set(members.map((m) => m.user_id)));
    const users = userIds.length
      ? await q<any>("SELECT * FROM users WHERE id = ANY($1::uuid[])", [userIds])
      : [];
    return {
      boards: boards.map(serialize.board),
      members: members.map(serialize.member),
      users: users.map(serialize.user),
    };
  });

  // POST /boards — create, owner added as member in one transaction.
  app.post("/boards", async (req, reply) => {
    const userId = await requireUserId(req);
    const body = createSchema.parse(req.body ?? {});
    const board = await tx(async (client) => {
      // Idempotent on the client-provided id so a retried drain doesn't
      // create duplicate boards.
      const inserted = await client.query(
        `INSERT INTO boards (id, owner_id, name, emoji, kind)
         VALUES (COALESCE($1, gen_random_uuid()), $2,$3,$4,$5)
         ON CONFLICT (id) DO NOTHING RETURNING *`,
        [body.id ?? null, userId, body.name, body.emoji ?? null, body.kind]
      );
      const b =
        inserted.rows[0] ??
        (await client.query(`SELECT * FROM boards WHERE id = $1`, [body.id])).rows[0];
      await client.query(
        `INSERT INTO board_members (board_id, user_id, role) VALUES ($1,$2,'owner')
         ON CONFLICT (board_id, user_id) DO NOTHING`,
        [b.id, userId]
      );
      return b;
    });
    reply.code(201);
    return serialize.board(board);
  });

  // PATCH /boards/:id — rename / change emoji.
  app.patch("/boards/:id", async (req) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    if (!(await isMember(userId, id))) throw forbidden();
    const patch = z
      .object({
        name: z.string().min(1).max(80).optional(),
        emoji: z.string().max(8).nullable().optional(),
        background: z.string().max(60).nullable().optional(),
      })
      .parse(req.body ?? {});

    const sets: string[] = [];
    const vals: unknown[] = [id];
    if (patch.name !== undefined) { vals.push(patch.name); sets.push(`name = $${vals.length}`); }
    if (patch.emoji !== undefined) { vals.push(patch.emoji); sets.push(`emoji = $${vals.length}`); }
    if (patch.background !== undefined) { vals.push(patch.background || null); sets.push(`background = $${vals.length}`); }
    if (sets.length === 0) throw notFound("nothing to update");
    sets.push("updated_at = now()");

    const board = await one<any>(`UPDATE boards SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, vals);
    if (!board) throw notFound();
    return serialize.board(board);
  });

  // POST /boards/:id/invite — returns an invite link.
  app.post("/boards/:id/invite", async (req, reply) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    if (!(await isMember(userId, id))) throw forbidden();
    const token = randomBytes(12).toString("base64url");
    await q(
      `INSERT INTO board_invites (token, board_id, created_by) VALUES ($1,$2,$3)`,
      [token, id, userId]
    );
    reply.code(201);
    return { token, url: `${config.PUBLIC_BASE_URL}/invite/${token}` };
  });

  // POST /boards/join — join via invite token.
  app.post("/boards/join", async (req) => {
    const userId = await requireUserId(req);
    const { token } = z.object({ token: z.string() }).parse(req.body ?? {});
    const invite = await one<any>("SELECT * FROM board_invites WHERE token = $1", [token]);
    if (!invite) throw notFound("bad invite");
    await q(
      `INSERT INTO board_members (board_id, user_id, role) VALUES ($1,$2,'member')
       ON CONFLICT (board_id, user_id) DO NOTHING`,
      [invite.board_id, userId]
    );
    await q(`UPDATE board_invites SET used_at = now() WHERE token = $1`, [token]);
    // An accepted invite makes the board shared (also re-stamps it for sync).
    await q(`UPDATE boards SET kind = 'shared', updated_at = now() WHERE id = $1`, [invite.board_id]);
    const board = await one<any>("SELECT * FROM boards WHERE id = $1", [invite.board_id]);
    if (!board) throw notFound();
    // Tell existing members that someone joined (best-effort).
    void (async () => {
      const u = await one<{ handle: string | null }>("SELECT handle FROM users WHERE id = $1", [userId]);
      await notifyBoard(board.id, userId, board.name, `@${u?.handle ?? "someone"} joined the board`, {
        board_id: board.id,
      });
    })();
    return serialize.board(board);
  });

  // DELETE /boards/:id — owner deletes a board (cascades cards/members/etc.).
  app.delete("/boards/:id", async (req, reply) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    if (!(await isOwner(userId, id))) throw forbidden("owner only");
    await q("DELETE FROM boards WHERE id = $1", [id]);
    reply.code(204);
    return null;
  });

  // DELETE /boards/:id/invites — owner revokes all outstanding invite links.
  app.delete("/boards/:id/invites", async (req, reply) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    if (!(await isOwner(userId, id))) throw forbidden("owner only");
    await q("DELETE FROM board_invites WHERE board_id = $1", [id]);
    reply.code(204);
    return null;
  });

  // DELETE /boards/:id/members/:userId — owner removes a member.
  app.delete("/boards/:id/members/:userId", async (req, reply) => {
    const callerId = await requireUserId(req);
    const { id, userId: target } = req.params as { id: string; userId: string };
    if (!(await isOwner(callerId, id))) throw forbidden("owner only");
    if (target === callerId) throw badRequest("owner cannot remove themselves");
    await q("DELETE FROM board_members WHERE board_id = $1 AND user_id = $2 AND role <> 'owner'", [id, target]);
    reply.code(204);
    return null;
  });

  // POST /boards/:id/leave — the caller leaves a shared board (owners can't).
  app.post("/boards/:id/leave", async (req, reply) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    const row = await one<{ role: string }>(
      "SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2",
      [id, userId]
    );
    if (!row) throw notFound();
    if (row.role === "owner") throw badRequest("owner cannot leave their own board");
    await q("DELETE FROM board_members WHERE board_id = $1 AND user_id = $2", [id, userId]);
    reply.code(204);
    return null;
  });
}
