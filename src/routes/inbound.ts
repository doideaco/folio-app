import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { one, q, tx, serialize } from "../db.js";
import { requireUserId } from "../auth.js";
import { config } from "../config.js";
import { putObject, storageEnabled } from "../storage.js";
import { notifyBoard } from "../push.js";
import { parseInboundEmail, emailBodyText, type InboundEmail } from "../inbound/parse.js";
import { reconcileKey, mergeRecords, diffRecords, type Rec } from "../inbound/reconcile.js";
import { resolveBrandLogo, imageSize } from "../inbound/brandLogo.js";

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
  date: z.string().optional(),
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

    const messageMs = email.date ? Date.parse(email.date) : NaN;
    const messageDate = Number.isNaN(messageMs) ? new Date() : new Date(messageMs);
    const parsed = parseInboundEmail(email, { now: messageDate });

    // Best-effort brand logo (server-fetched once per domain, re-hosted on our
    // bucket) so the card can show e.g. the Booking.com / BA mark.
    if (parsed.providerDomain && (parsed.extracted as Rec).kind === "record") {
      const logo = await resolveBrandLogo(parsed.providerDomain).catch(() => null);
      if (logo) (parsed.extracted as Rec).provider_logo = logo;
    }

    // Keep a capped copy of the email so on-device extraction can deep-parse it.
    // Use the rendered body (falls back to stripped HTML) — most transactional
    // senders are HTML-only, so `email.text` alone would leave just the subject.
    const rawText = `${email.subject ?? ""}\n\n${emailBodyText(email)}`.slice(0, 6000).trim() || null;
    const key = (parsed.extracted as Rec).kind === "record" ? reconcileKey(parsed.extracted as Rec) : null;

    // --- Reconciliation: a later email about the same booking updates the same
    //     card. The card's `extracted` is a projection folded from all its sources.
    if (key) {
      const existing = await one<{ id: string; board_id: string }>(
        "SELECT id, board_id FROM cards WHERE added_by = $1 AND ref = $2 LIMIT 1",
        [userId, key]
      );
      if (existing) {
        const src = await one<{ id: string }>(
          `INSERT INTO card_sources (card_id, user_id, message_date, subject, rec)
           VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
          [existing.id, userId, messageDate.toISOString(), email.subject ?? null, JSON.stringify(parsed.extracted)]
        );
        const rows = await q<{ id: string; message_date: string; rec: Rec }>(
          "SELECT id, message_date, rec FROM card_sources WHERE card_id = $1", [existing.id]
        );
        const all = rows.map((r) => ({ date: new Date(r.message_date).toISOString(), rec: r.rec }));
        const before = rows.length > 1
          ? mergeRecords(rows.filter((r) => r.id !== src!.id).map((r) => ({ date: new Date(r.message_date).toISOString(), rec: r.rec })))
          : null;
        const after = mergeRecords(all);
        after.kind = "record";
        after.source_count = rows.length;
        const changes = diffRecords(before, after);
        if (changes.length) after.changes = changes;

        const updated = await one<any>(
          `UPDATE cards SET extracted = $1::jsonb, title = $2, event_at = $3, raw_text = $4, updated_at = now()
           WHERE id = $5 RETURNING *`,
          [JSON.stringify(after), String(after.title ?? parsed.title).slice(0, 300),
           (after.date as string) ?? parsed.eventAt ?? null, rawText, existing.id]
        );
        const note = changes.length ? `Updated: ${changes[0]}` : `Updated: ${parsed.title.slice(0, 60)}`;
        void notifyBoard(existing.board_id, userId, parsed.boardName, note, { board_id: existing.board_id });
        reply.code(200);
        return { ok: true, card_id: updated.id, board_id: existing.board_id, updated: true };
      }
    }

    // --- New card (first email for this booking, or non-reconcilable).
    const boardId = await ensureBoard(userId, parsed.boardName, parsed.boardEmoji);

    // Re-host an image attachment as the thumbnail, if we have one.
    let thumbUrl: string | null = null;
    if (parsed.thumb && storageEnabled) {
      try {
        const buf = Buffer.from(parsed.thumb.base64, "base64");
        // Skip logos/tracking pixels — only re-host a genuine content image
        // (≥128px on the short edge). Avoids junk thumbnails + wasted storage.
        const size = imageSize(buf);
        const bigEnough = size ? Math.min(size.w, size.h) >= 128 : buf.length >= 20_000;
        if (buf.length > 0 && buf.length < 12 * 1024 * 1024 && bigEnough) {
          const ext = parsed.thumb.mimeType.includes("png") ? "png" : "jpg";
          thumbUrl = await putObject(`inbound/${randomUUID()}.${ext}`, buf, parsed.thumb.mimeType);
        }
      } catch { /* thumb is best-effort */ }
    }

    const extracted = parsed.extracted as Rec;
    if (key) extracted.source_count = 1;

    const card = await one<any>(
      `INSERT INTO cards (board_id, added_by, source_url, type, status, title, thumb_url, caption, extracted, raw_text, event_at, ref)
       VALUES ($1,$2,$3,$4,'ready',$5,$6,$7,$8::jsonb,$9,$10,$11)
       RETURNING *`,
      [
        boardId, userId, parsed.sourceUrl, parsed.cardType,
        parsed.title.slice(0, 300), thumbUrl, parsed.caption,
        JSON.stringify(extracted), rawText, parsed.eventAt ?? null, key,
      ]
    );

    if (key) {
      await q(
        `INSERT INTO card_sources (card_id, user_id, message_date, subject, rec)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [card.id, userId, messageDate.toISOString(), email.subject ?? null, JSON.stringify(parsed.extracted)]
      );
    }

    // Let shared-board members know (best-effort; no-op on solo boards).
    void notifyBoard(boardId, userId, parsed.boardName, `New save: ${parsed.title.slice(0, 80)}`, { board_id: boardId });

    reply.code(201);
    return { ok: true, card_id: card.id, board_id: boardId };
  });
}
