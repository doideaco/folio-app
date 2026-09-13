import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { one, q, tx, serialize } from "../db.js";
import { requireUserId } from "../auth.js";
import { config } from "../config.js";
import { putObject, storageEnabled } from "../storage.js";
import { notifyBoard } from "../push.js";
import { parseInboundEmail, type InboundEmail } from "../inbound/parse.js";

/** Extract the forwarding token from a recipient address: strips a display
 *  name, the domain, and any +tag → the local part before '+'. */
function tokenFromRecipient(to: string): string | null {
  const angle = to.match(/<([^>]+)>/);
  const addr = (angle?.[1] ?? to).trim().toLowerCase();
  const local = addr.split("@")[0] ?? "";
  const token = local.split("+")[0]?.trim();
  return token || null;
}

/** Find (or lazily create) the caller's stable forwarding token. */
async function ensureToken(userId: string): Promise<string> {
  const existing = await one<{ token: string }>(
    "SELECT token FROM inbound_addresses WHERE user_id = $1",
    [userId]
  );
  if (existing) return existing.token;
  const handle = (await one<{ handle: string | null }>("SELECT handle FROM users WHERE id = $1", [userId]))?.handle;
  const slug = (handle ?? "u").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "u";
  // Retry on the (astronomically unlikely) token PK collision.
  for (let i = 0; i < 5; i++) {
    const token = `${slug}-${randomUUID().replace(/-/g, "").slice(0, 6)}`;
    // DO NOTHING on the user_id unique constraint returns no row if the user
    // already has one; a token PK collision throws and is caught → retry.
    const row = await one<{ token: string }>(
      `INSERT INTO inbound_addresses (token, user_id) VALUES ($1,$2)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING token`,
      [token, userId]
    ).catch(() => null);
    if (row) return row.token;
    const again = await one<{ token: string }>("SELECT token FROM inbound_addresses WHERE user_id = $1", [userId]);
    if (again) return again.token;
  }
  throw new Error("could not allocate inbound token");
}

/** Find a user's board by name (case-insensitive), else create it (solo, owned). */
async function ensureBoard(userId: string, name: string, emoji: string): Promise<string> {
  const found = await one<{ id: string }>(
    "SELECT id FROM boards WHERE owner_id = $1 AND lower(name) = lower($2) LIMIT 1",
    [userId, name]
  );
  if (found) return found.id;
  return await tx(async (client) => {
    const b = (await client.query(
      `INSERT INTO boards (owner_id, name, emoji, kind) VALUES ($1,$2,$3,'solo') RETURNING id`,
      [userId, name, emoji]
    )).rows[0];
    await client.query(
      `INSERT INTO board_members (board_id, user_id, role) VALUES ($1,$2,'owner')
       ON CONFLICT (board_id, user_id) DO NOTHING`,
      [b.id, userId]
    );
    return b.id as string;
  });
}

const attachmentSchema = z.object({
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  contentBase64: z.string().optional(),
});

const emailSchema = z.object({
  to: z.string(),
  from: z.string().optional(),
  subject: z.string().optional(),
  html: z.string().optional(),
  text: z.string().optional(),
  attachments: z.array(attachmentSchema).optional(),
});

export async function inboundRoutes(app: FastifyInstance) {
  // GET /inbound/address — the caller's forwarding address (created on demand).
  app.get("/inbound/address", async (req) => {
    const userId = await requireUserId(req);
    const token = await ensureToken(userId);
    return { token, address: `${token}@${config.INBOUND_DOMAIN}`, domain: config.INBOUND_DOMAIN };
  });

  // POST /inbound/email — webhook from the Cloudflare email Worker. Authenticated
  // by a shared secret, NOT a user session. Always 200 so mail never bounces.
  app.post("/inbound/email", async (req, reply) => {
    if (!config.INBOUND_SECRET) {
      reply.code(503);
      return { ok: false, reason: "inbound disabled" };
    }
    const auth = (req.headers["authorization"] ?? "").toString();
    const presented = auth.replace(/^Bearer\s+/i, "");
    if (presented !== config.INBOUND_SECRET) {
      reply.code(401);
      return { ok: false, reason: "bad secret" };
    }

    const email = emailSchema.parse(req.body ?? {}) as InboundEmail;
    const token = tokenFromRecipient(email.to);
    const owner = token
      ? await one<{ user_id: string }>("SELECT user_id FROM inbound_addresses WHERE token = $1", [token])
      : null;
    if (!owner) {
      // Unknown recipient — accept and drop so the sender gets no bounce.
      return { ok: false, reason: "unknown recipient" };
    }
    const userId = owner.user_id;

    const parsed = parseInboundEmail(email);
    const boardId = await ensureBoard(userId, parsed.boardName, parsed.boardEmoji);

    // Re-host an image attachment as the thumbnail, if we have one.
    let thumbUrl: string | null = null;
    if (parsed.thumb && storageEnabled) {
      try {
        const buf = Buffer.from(parsed.thumb.base64, "base64");
        if (buf.length > 0 && buf.length < 12 * 1024 * 1024) {
          const ext = parsed.thumb.mimeType.includes("png") ? "png" : "jpg";
          thumbUrl = await putObject(`inbound/${randomUUID()}.${ext}`, buf, parsed.thumb.mimeType);
        }
      } catch { /* thumb is best-effort */ }
    }

    const card = await one<any>(
      `INSERT INTO cards (board_id, added_by, source_url, type, status, title, thumb_url, caption, extracted)
       VALUES ($1,$2,$3,$4,'ready',$5,$6,$7,$8::jsonb)
       RETURNING *`,
      [
        boardId, userId, parsed.sourceUrl, parsed.cardType,
        parsed.title.slice(0, 300), thumbUrl, parsed.caption,
        JSON.stringify(parsed.extracted),
      ]
    );

    // Let shared-board members know (best-effort; no-op on solo boards).
    void notifyBoard(boardId, userId, parsed.boardName, `New save: ${parsed.title.slice(0, 80)}`, { board_id: boardId });

    reply.code(201);
    return { ok: true, card_id: card.id, board_id: boardId };
  });
}
