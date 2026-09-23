import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q, one } from "../db.js";
import { requireUserId } from "../auth.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { isMember } from "./boards.js";
import { notifyUser, notifyBoard } from "../push.js";

// Don't re-nudge someone more than once a day.
const REMIND_COOLDOWN_MS = 20 * 60 * 60 * 1000;

const userSummary = (u: any) => ({
  id: u.id,
  handle: u.handle,
  display_name: u.display_name,
  avatar_url: u.avatar_url,
});

export async function invitesRoutes(app: FastifyInstance) {
  // GET /users/lookup?handle= — resolve a handle to a user (exact match only, so
  // it can't be used to browse/enumerate the directory).
  app.get("/users/lookup", async (req) => {
    await requireUserId(req);
    const handle = String((req.query as { handle?: string }).handle ?? "")
      .trim().replace(/^@/, "");
    if (handle.length < 2) throw badRequest("handle too short");
    const user = await one<any>(
      "SELECT id, handle, display_name, avatar_url FROM users WHERE lower(handle) = lower($1)",
      [handle]
    );
    if (!user) throw notFound("no such user");
    return userSummary(user);
  });

  // POST /boards/:id/invite-user { handle } — invite a specific Folio user.
  app.post("/boards/:id/invite-user", async (req, reply) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    const { handle } = z.object({ handle: z.string().min(2).max(40) }).parse(req.body ?? {});
    if (!(await isMember(userId, id))) throw forbidden();

    const invitee = await one<any>(
      "SELECT id, handle FROM users WHERE lower(handle) = lower($1)",
      [handle.replace(/^@/, "")]
    );
    if (!invitee) throw notFound("no such user");
    if (invitee.id === userId) throw badRequest("that's you");

    const already = await one("SELECT 1 FROM board_members WHERE board_id = $1 AND user_id = $2", [id, invitee.id]);
    if (already) throw conflict("already a member");

    // Anti-spam: cap how many people one person can invite per day.
    const recent = await one<{ n: number }>(
      "SELECT count(*)::int AS n FROM board_direct_invites WHERE inviter_id = $1 AND created_at > now() - interval '1 day'",
      [userId]
    );
    if ((recent?.n ?? 0) >= 20) throw forbidden("invite limit reached — try again tomorrow");

    // One invite per (board, invitee): re-inviting a declined/pending row resets
    // it to pending and re-stamps the inviter.
    const invite = await one<any>(
      `INSERT INTO board_direct_invites (board_id, inviter_id, invitee_id, status)
       VALUES ($1,$2,$3,'pending')
       ON CONFLICT (board_id, invitee_id)
       DO UPDATE SET status = 'pending', inviter_id = EXCLUDED.inviter_id, updated_at = now()
       RETURNING *`,
      [id, userId, invitee.id]
    );

    await pushInvite(invite.id, userId, invitee.id, id);
    reply.code(201);
    return serializeInvite(invite);
  });

  // GET /invites — my incoming pending invites (enriched for the inbox).
  app.get("/invites", async (req) => {
    const userId = await requireUserId(req);
    const rows = await q<any>(
      `SELECT di.id, di.board_id, di.status, di.created_at,
              b.name AS board_name, b.emoji AS board_emoji,
              u.handle AS inviter_handle, u.display_name AS inviter_name
       FROM board_direct_invites di
       JOIN boards b ON b.id = di.board_id
       JOIN users u ON u.id = di.inviter_id
       WHERE di.invitee_id = $1 AND di.status = 'pending'
       ORDER BY di.created_at DESC`,
      [userId]
    );
    return rows.map((r) => ({
      id: r.id,
      board_id: r.board_id,
      board_name: r.board_name,
      board_emoji: r.board_emoji,
      inviter_handle: r.inviter_handle,
      inviter_name: r.inviter_name,
      status: r.status,
      created_at: r.created_at,
    }));
  });

  // GET /boards/:id/invites — outgoing invites for a board (status list).
  app.get("/boards/:id/invites", async (req) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    if (!(await isMember(userId, id))) throw forbidden();
    const rows = await q<any>(
      `SELECT di.id, di.status, di.reminded_at, di.created_at,
              u.handle AS invitee_handle, u.display_name AS invitee_name, u.id AS invitee_id
       FROM board_direct_invites di
       JOIN users u ON u.id = di.invitee_id
       WHERE di.board_id = $1 AND di.status = 'pending'
       ORDER BY di.created_at DESC`,
      [id]
    );
    return rows.map((r) => ({
      id: r.id,
      invitee_id: r.invitee_id,
      invitee_handle: r.invitee_handle,
      invitee_name: r.invitee_name,
      status: r.status,
      reminded_at: r.reminded_at,
      created_at: r.created_at,
    }));
  });

  // POST /invites/:id/accept — invitee joins the board.
  app.post("/invites/:id/accept", async (req) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    const invite = await one<any>("SELECT * FROM board_direct_invites WHERE id = $1", [id]);
    if (!invite || invite.invitee_id !== userId) throw notFound();
    if (invite.status !== "pending") throw conflict("already handled");

    await q(
      `INSERT INTO board_members (board_id, user_id, role) VALUES ($1,$2,'member')
       ON CONFLICT (board_id, user_id) DO NOTHING`,
      [invite.board_id, userId]
    );
    await q("UPDATE board_direct_invites SET status = 'accepted', updated_at = now() WHERE id = $1", [id]);
    await q("UPDATE boards SET kind = 'shared', updated_at = now() WHERE id = $1", [invite.board_id]);
    const board = await one<any>("SELECT * FROM boards WHERE id = $1", [invite.board_id]);
    if (!board) throw notFound();
    void (async () => {
      const u = await one<{ handle: string | null }>("SELECT handle FROM users WHERE id = $1", [userId]);
      await notifyBoard(board.id, userId, board.name, `@${u?.handle ?? "someone"} joined the board`, {
        board_id: board.id,
      });
    })();
    const { serialize } = await import("../db.js");
    return serialize.board(board);
  });

  // POST /invites/:id/decline — invitee dismisses the invite.
  app.post("/invites/:id/decline", async (req, reply) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    const invite = await one<any>("SELECT * FROM board_direct_invites WHERE id = $1", [id]);
    if (!invite || invite.invitee_id !== userId) throw notFound();
    await q("UPDATE board_direct_invites SET status = 'declined', updated_at = now() WHERE id = $1", [id]);
    reply.code(204);
    return null;
  });

  // POST /invites/:id/remind — inviter re-pings the invitee (rate-limited).
  app.post("/invites/:id/remind", async (req) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    const invite = await one<any>("SELECT * FROM board_direct_invites WHERE id = $1", [id]);
    if (!invite || invite.inviter_id !== userId) throw notFound();
    if (invite.status !== "pending") throw conflict("not pending");
    const last = invite.reminded_at ? new Date(invite.reminded_at).getTime() : 0;
    if (Date.now() - last < REMIND_COOLDOWN_MS) throw conflict("already reminded recently");
    await q("UPDATE board_direct_invites SET reminded_at = now() WHERE id = $1", [id]);
    await pushInvite(invite.id, userId, invite.invitee_id, invite.board_id, true);
    return { ok: true };
  });

  // Push the invitee about a new (or repeated) invite.
  async function pushInvite(inviteId: string, inviterId: string, inviteeId: string, boardId: string, reminder = false) {
    const inviter = await one<{ handle: string | null }>("SELECT handle FROM users WHERE id = $1", [inviterId]);
    const board = await one<{ name: string }>("SELECT name FROM boards WHERE id = $1", [boardId]);
    const who = inviter?.handle ? `@${inviter.handle}` : "Someone";
    const title = reminder ? "Reminder" : "Board invite";
    void notifyUser(
      inviteeId, title, `${who} invited you to “${board?.name ?? "a board"}” on Folio`,
      { type: "invite", invite_id: inviteId, board_id: boardId }
    );
  }
}

function serializeInvite(r: any) {
  return {
    id: r.id,
    board_id: r.board_id,
    inviter_id: r.inviter_id,
    invitee_id: r.invitee_id,
    status: r.status,
    reminded_at: r.reminded_at,
    created_at: r.created_at,
  };
}
