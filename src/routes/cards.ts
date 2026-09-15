import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { one, serialize } from "../db.js";
import { requireUserId } from "../auth.js";
import { forbidden, notFound } from "../errors.js";
import { isMember } from "./boards.js";
import { runExtraction } from "../extraction.js";

async function cardBoardId(cardId: string): Promise<string | null> {
  const row = await one<{ board_id: string }>("SELECT board_id FROM cards WHERE id = $1", [cardId]);
  return row?.board_id ?? null;
}

const patchSchema = z.object({
  board_id: z.string().uuid().optional(),
  type: z.enum(["recipe", "place", "interior", "fit", "link", "other"]).optional(),
  tried_at: z.string().datetime().nullable().optional(),
  clear_tried: z.boolean().optional(),
  clear_event_at: z.boolean().optional(),
  user_note: z.string().nullable().optional(),
  background: z.string().max(1000).nullable().optional(), // "gradient:x" or "photo:<url>"
  lat: z.number().optional(),
  lng: z.number().optional(),
  place_address: z.string().max(300).optional(),
  place_category: z.string().max(40).optional(),
  place_phone: z.string().max(60).optional(),
  place_website: z.string().max(500).optional(),
  // On-device web enrichment.
  title: z.string().max(300).optional(),
  caption: z.string().max(2000).optional(),
  thumb_url: z.string().max(1000).optional(),
  link_description: z.string().max(2000).optional(),
  og_image: z.string().max(1000).optional(),
  price: z.string().max(40).optional(),
  brand: z.string().max(120).optional(),
  // On-device context engine: a normalized structured record + its key date.
  record: z.record(z.string(), z.any()).optional(),
  // On-device recipe extraction (freeform captions → structured recipe).
  recipe: z.record(z.string(), z.any()).optional(),
  event_at: z.string().datetime().nullable().optional(),
});

export async function cardsRoutes(app: FastifyInstance) {
  // POST /cards/:id/comments
  app.post("/cards/:id/comments", async (req, reply) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    const boardId = await cardBoardId(id);
    if (!boardId) throw notFound();
    if (!(await isMember(userId, boardId))) throw forbidden();
    const { body } = z.object({ body: z.string().min(1) }).parse(req.body ?? {});
    const comment = await one<any>(
      `INSERT INTO card_comments (card_id, user_id, body) VALUES ($1,$2,$3) RETURNING *`,
      [id, userId, body]
    );
    reply.code(201);
    return serialize.comment(comment);
  });

  // PUT /cards/:id/rating — set the caller's personal 1–5 rating (upsert).
  app.put("/cards/:id/rating", async (req) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    const boardId = await cardBoardId(id);
    if (!boardId) throw notFound();
    if (!(await isMember(userId, boardId))) throw forbidden();
    const { rating } = z.object({ rating: z.number().int().min(1).max(5) }).parse(req.body ?? {});
    const row = await one<any>(
      `INSERT INTO card_ratings (card_id, user_id, rating) VALUES ($1,$2,$3)
       ON CONFLICT (card_id, user_id) DO UPDATE SET rating = EXCLUDED.rating, updated_at = now()
       RETURNING *`,
      [id, userId, rating]
    );
    return serialize.rating(row);
  });

  // DELETE /cards/:id/rating — clear the caller's rating.
  app.delete("/cards/:id/rating", async (req, reply) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    await one("DELETE FROM card_ratings WHERE card_id = $1 AND user_id = $2", [id, userId]);
    reply.code(204);
    return null;
  });

  // PUT /cards/:id/fave — favourite a card for the caller.
  app.put("/cards/:id/fave", async (req) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    const boardId = await cardBoardId(id);
    if (!boardId) throw notFound();
    if (!(await isMember(userId, boardId))) throw forbidden();
    const row = await one<any>(
      `INSERT INTO card_faves (card_id, user_id) VALUES ($1,$2)
       ON CONFLICT (card_id, user_id) DO UPDATE SET card_id = EXCLUDED.card_id
       RETURNING *`,
      [id, userId]
    );
    return serialize.fave(row);
  });

  // DELETE /cards/:id/fave — unfavourite for the caller.
  app.delete("/cards/:id/fave", async (req, reply) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    await one("DELETE FROM card_faves WHERE card_id = $1 AND user_id = $2", [id, userId]);
    reply.code(204);
    return null;
  });

  // POST /cards/:id/tasks — add a checklist item.
  app.post("/cards/:id/tasks", async (req, reply) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    const boardId = await cardBoardId(id);
    if (!boardId) throw notFound();
    if (!(await isMember(userId, boardId))) throw forbidden();
    const body = z.object({
      id: z.string().uuid().optional(),
      text: z.string().min(1).max(300),
      position: z.number().optional(),
    }).parse(req.body ?? {});
    const row = await one<any>(
      `INSERT INTO card_tasks (id, card_id, text, position) VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4)
       ON CONFLICT (id) DO NOTHING RETURNING *`,
      [body.id ?? null, id, body.text, body.position ?? 0]
    );
    reply.code(201);
    return serialize.task(row);
  });

  // PATCH /tasks/:taskId — toggle done / edit text.
  app.patch("/tasks/:taskId", async (req) => {
    const userId = await requireUserId(req);
    const { taskId } = req.params as { taskId: string };
    const task = await one<any>("SELECT * FROM card_tasks WHERE id = $1", [taskId]);
    if (!task) throw notFound();
    const boardId = await cardBoardId(task.card_id);
    if (!boardId || !(await isMember(userId, boardId))) throw forbidden();
    const patch = z.object({
      text: z.string().min(1).max(300).optional(),
      done: z.boolean().optional(),
    }).parse(req.body ?? {});
    const updated = await one<any>(
      `UPDATE card_tasks SET text = COALESCE($2, text), done = COALESCE($3, done) WHERE id = $1 RETURNING *`,
      [taskId, patch.text ?? null, patch.done ?? null]
    );
    return serialize.task(updated);
  });

  // DELETE /tasks/:taskId
  app.delete("/tasks/:taskId", async (req, reply) => {
    const userId = await requireUserId(req);
    const { taskId } = req.params as { taskId: string };
    const task = await one<any>("SELECT * FROM card_tasks WHERE id = $1", [taskId]);
    if (task) {
      const boardId = await cardBoardId(task.card_id);
      if (!boardId || !(await isMember(userId, boardId))) throw forbidden();
      await one("DELETE FROM card_tasks WHERE id = $1", [taskId]);
    }
    reply.code(204);
    return null;
  });

  // POST /cards/:id/reextract — re-run extraction (e.g. card came back thin).
  app.post("/cards/:id/reextract", async (req, reply) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    const boardId = await cardBoardId(id);
    if (!boardId) throw notFound();
    if (!(await isMember(userId, boardId))) throw forbidden();

    // Email-derived records have no web page to re-fetch — re-extraction would
    // replace their rich record with a thin stub. Leave them untouched.
    const existing = await one<any>("SELECT * FROM cards WHERE id = $1", [id]);
    if (!existing?.source_url) {
      reply.code(200);
      return serialize.card(existing);
    }

    await one(
      `INSERT INTO card_extraction_state (card_id, attempts, next_stage, next_retry_at, last_error)
       VALUES ($1, 0, 'fetch', now(), NULL)
       ON CONFLICT (card_id) DO UPDATE SET attempts = 0, next_retry_at = now(), last_error = NULL`,
      [id]
    );
    await one(`UPDATE cards SET status='pending', updated_at=now() WHERE id = $1`, [id]);
    void runExtraction(id);

    reply.code(202);
    const card = await one<any>("SELECT * FROM cards WHERE id = $1", [id]);
    return serialize.card(card);
  });

  // PATCH /cards/:id
  app.patch("/cards/:id", async (req) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    const boardId = await cardBoardId(id);
    if (!boardId) throw notFound();
    if (!(await isMember(userId, boardId))) throw forbidden();
    const patch = patchSchema.parse(req.body ?? {});

    if (patch.board_id && !(await isMember(userId, patch.board_id))) {
      throw forbidden("not a member of target board");
    }

    const sets: string[] = [];
    const vals: unknown[] = [id];
    const push = (col: string, val: unknown) => {
      vals.push(val);
      sets.push(`${col} = $${vals.length}`);
    };
    if (patch.board_id !== undefined) push("board_id", patch.board_id);
    if (patch.type !== undefined) push("type", patch.type);
    if (patch.tried_at !== undefined) push("tried_at", patch.tried_at);
    else if (patch.clear_tried) push("tried_at", null);
    if (patch.user_note !== undefined) push("user_note", patch.user_note);
    if (patch.background !== undefined) push("background", patch.background || null);
    // Merge geocoded coordinates in, forcing a place shape (keeps any existing
    // name, else uses the title) so a card set-as-place becomes mappable.
    if (patch.lat !== undefined && patch.lng !== undefined) {
      vals.push(patch.lat); const a = vals.length;
      vals.push(patch.lng); const b = vals.length;
      sets.push(
        `extracted = coalesce(extracted, '{}'::jsonb) || jsonb_build_object(
           'kind','place', 'lat', $${a}::float8, 'lng', $${b}::float8,
           'name', coalesce(extracted->'name', to_jsonb(title)))`
      );
    }
    // Merge enriched place detail (address/category/phone/website) into the
    // extracted place shape. Only provided fields are set.
    const placeFields: Array<[string, unknown]> = [];
    if (patch.place_address !== undefined) placeFields.push(["address", patch.place_address]);
    if (patch.place_category !== undefined) placeFields.push(["category", patch.place_category]);
    if (patch.place_phone !== undefined) placeFields.push(["phone", patch.place_phone]);
    if (patch.place_website !== undefined) placeFields.push(["website", patch.place_website]);
    if (placeFields.length > 0) {
      const objArgs = placeFields
        .map(([key, value]) => {
          vals.push(value);
          return `'${key}', $${vals.length}::text`;
        })
        .join(", ");
      sets.push(
        `extracted = coalesce(extracted, jsonb_build_object('kind','place')) || jsonb_build_object(${objArgs})`
      );
    }

    // On-device web enrichment: card columns…
    if (patch.title !== undefined) push("title", patch.title);
    if (patch.caption !== undefined) push("caption", patch.caption);
    if (patch.thumb_url !== undefined) push("thumb_url", patch.thumb_url);
    // …and link extract detail merged into the extracted JSON.
    const linkFields: Array<[string, unknown]> = [];
    if (patch.link_description !== undefined) linkFields.push(["description", patch.link_description]);
    if (patch.og_image !== undefined) linkFields.push(["og_image", patch.og_image]);
    if (patch.price !== undefined) linkFields.push(["price", patch.price]);
    if (patch.brand !== undefined) linkFields.push(["brand", patch.brand]);
    if (linkFields.length > 0) {
      const objArgs = linkFields
        .map(([key, value]) => {
          vals.push(value);
          return `'${key}', $${vals.length}::text`;
        })
        .join(", ");
      sets.push(
        `extracted = coalesce(extracted, jsonb_build_object('kind','link')) || jsonb_build_object(${objArgs})`
      );
    }

    // Replace the extracted payload with a normalized record (inject the
    // discriminator the client decoder switches on).
    if (patch.record !== undefined) {
      vals.push(JSON.stringify(patch.record));
      sets.push(`extracted = ($${vals.length}::jsonb) || '{"kind":"record"}'::jsonb`);
    }
    // Replace the extracted payload with a structured recipe (on-device).
    if (patch.recipe !== undefined) {
      vals.push(JSON.stringify(patch.recipe));
      sets.push(`extracted = ($${vals.length}::jsonb) || '{"kind":"recipe"}'::jsonb`);
    }
    if (patch.event_at !== undefined) push("event_at", patch.event_at);
    else if (patch.clear_event_at) push("event_at", null);

    sets.push("updated_at = now()");

    const card = await one<any>(
      `UPDATE cards SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      vals
    );
    if (!card) throw notFound();
    return serialize.card(card);
  });

  // DELETE /cards/:id
  app.delete("/cards/:id", async (req, reply) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    const boardId = await cardBoardId(id);
    if (!boardId) {
      reply.code(204);
      return null;
    }
    if (!(await isMember(userId, boardId))) throw forbidden();
    await one("DELETE FROM cards WHERE id = $1", [id]);
    reply.code(204);
    return null;
  });
}
