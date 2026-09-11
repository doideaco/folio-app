import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { one, q, serialize } from "../db.js";
import { requireUserId } from "../auth.js";
import { forbidden, badRequest } from "../errors.js";
import { isMember } from "./boards.js";
import { runExtraction } from "../extraction.js";
import { notifyBoard } from "../push.js";

const schema = z.object({
  id: z.string().uuid().optional(), // client-generated card id (idempotency key)
  source_url: z.string().url().optional(),
  media_upload_id: z.string().optional(),
  board_id: z.string().uuid(),
  type_guess: z
    .enum(["recipe", "place", "interior", "fit", "link", "other"])
    .default("other"),
  note: z.string().optional(),
  category: z.string().max(40).optional(),
  image_url: z.string().url().optional(), // uploaded screenshot/image
});

function sourceKindFrom(url: string | undefined): string | null {
  if (!url) return "media";
  if (/\/reels?\//.test(url)) return "reel";
  if (/\/(p|tv|share)\//.test(url)) return "post";
  return "post";
}

export async function savesRoutes(app: FastifyInstance) {
  app.post("/saves", async (req, reply) => {
    const userId = await requireUserId(req);
    const body = schema.parse(req.body ?? {});
    if (!body.source_url && !body.media_upload_id && !body.image_url) {
      throw badRequest("source_url, media_upload_id or image_url required");
    }
    if (!(await isMember(userId, body.board_id))) throw forbidden("not a board member");

    // Idempotent on the client-provided id: a retried/concurrent save with the
    // same id returns the existing card instead of creating a duplicate.
    const id = body.id ?? null;
    // Seed the extracted place shape with the user's chosen category so it's
    // preserved through extraction (which reads it back as a fallback).
    const seededExtracted =
      body.category && body.type_guess === "place"
        ? JSON.stringify({ kind: "place", category: body.category })
        : null;
    // An uploaded image is already "the content" — mark it ready with the image
    // as its thumbnail and skip the extraction pipeline.
    const isImage = Boolean(body.image_url);
    const status = isImage ? "ready" : "pending";
    // Image cards skip extraction, so give them a title now; link/post cards get
    // theirs from extraction.
    const title = isImage ? "Screenshot" : null;
    let card = await one<any>(
      `INSERT INTO cards (id, board_id, added_by, source_url, source_kind, type, status, user_note, extracted, thumb_url, title)
       VALUES (COALESCE($1, gen_random_uuid()), $2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [
        id,
        body.board_id,
        userId,
        body.source_url ?? null,
        sourceKindFrom(body.source_url),
        body.type_guess,
        status,
        body.note ?? null,
        seededExtracted,
        body.image_url ?? null,
        title,
      ]
    );

    if (!card && id) {
      // Conflict: the card already exists — return it unchanged (no re-notify).
      card = await one<any>("SELECT * FROM cards WHERE id = $1", [id]);
      reply.code(200);
      return serialize.card(card);
    }

    // Notify the rest of the board that a card was added (best-effort).
    void (async () => {
      const info = await one<{ board: string; handle: string | null }>(
        "SELECT b.name AS board, u.handle FROM boards b JOIN users u ON u.id = $2 WHERE b.id = $1",
        [card.board_id, userId]
      );
      if (info) {
        await notifyBoard(card.board_id, userId, info.board, `@${info.handle ?? "someone"} added a save`, {
          board_id: card.board_id,
        });
      }
    })();

    // Image saves are already ready — no extraction to run.
    if (isImage) {
      reply.code(201);
      return serialize.card(card);
    }

    await q(
      `INSERT INTO card_extraction_state (card_id, next_stage) VALUES ($1,'fetch')
       ON CONFLICT (card_id) DO NOTHING`,
      [card.id]
    );

    // Kick the (stub) extraction pipeline; the client polls /sync for progress.
    void runExtraction(card.id);

    reply.code(202);
    return serialize.card(card);
  });
}
