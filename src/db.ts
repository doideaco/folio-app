import pg from "pg";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config.js";

// Managed Postgres (Render, Neon, Supabase, …) requires TLS; local Postgres
// doesn't offer it. Enable SSL for any non-local DATABASE_URL.
const isLocalDb = /@(localhost|127\.0\.0\.1)[:/]/.test(config.DATABASE_URL);
export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  ssl: isLocalDb ? undefined : { rejectUnauthorized: false },
});

// A dropped/idle connection emits 'error' on the pool. Without a handler this
// crashes the whole process — the classic "lost DB connection took down the
// API". Log and let the pool recreate connections on the next query.
pool.on("error", (err) => {
  console.error("[pg] pool error (recovering):", err.message);
});

export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

/// Apply the idempotent schema. Run on boot so hosted deploys self-migrate.
export async function applySchema(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = await readFile(join(here, "schema.sql"), "utf8");
  await pool.query(sql);
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Serializers ---------------------------------------------------------------
// Produce exactly the snake_case shapes the iOS models decode. node-pg returns
// timestamptz as Date (Fastify stringifies to ISO) and jsonb already parsed.

export const serialize = {
  user: (r: any) => ({
    id: r.id,
    handle: r.handle,
    display_name: r.display_name,
    avatar_url: r.avatar_url,
    created_at: r.created_at,
  }),
  board: (r: any) => ({
    id: r.id,
    owner_id: r.owner_id,
    name: r.name,
    emoji: r.emoji,
    cover_card_id: r.cover_card_id,
    kind: r.kind,
    private: r.private ?? false,
    background: r.background ?? null,
    public_slug: r.public_slug ?? null,
    decide_by: r.decide_by ?? null,
    decided_card_id: r.decided_card_id ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }),
  member: (r: any) => ({
    board_id: r.board_id,
    user_id: r.user_id,
    role: r.role,
    joined_at: r.joined_at,
  }),
  card: (r: any) => ({
    id: r.id,
    board_id: r.board_id,
    added_by: r.added_by,
    source_url: r.source_url,
    source_kind: r.source_kind,
    type: r.type,
    status: r.status,
    title: r.title,
    thumb_url: r.thumb_url,
    media_urls: r.media_urls ?? [],
    author_handle: r.author_handle,
    caption: r.caption,
    extracted: r.extracted ?? null,
    user_note: r.user_note,
    tried_at: r.tried_at,
    background: r.background ?? null,
    raw_text: r.raw_text ?? null,
    event_at: r.event_at ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }),
  comment: (r: any) => ({
    id: r.id,
    card_id: r.card_id,
    user_id: r.user_id,
    body: r.body,
    created_at: r.created_at,
  }),
  rating: (r: any) => ({
    id: r.id,
    card_id: r.card_id,
    user_id: r.user_id,
    rating: r.rating,
    updated_at: r.updated_at,
  }),
  fave: (r: any) => ({
    id: r.id,
    card_id: r.card_id,
    user_id: r.user_id,
    created_at: r.created_at,
  }),
  vote: (r: any) => ({
    id: r.id,
    card_id: r.card_id,
    user_id: r.user_id,
    created_at: r.created_at,
  }),
  dateVote: (r: any) => ({
    id: r.id,
    board_id: r.board_id,
    user_id: r.user_id,
    // pg returns a `date` as a JS Date at *local* midnight; re-anchor to that
    // calendar day at UTC midnight and emit ISO8601 so the client's date decoder
    // (same path as created_at) parses it and reads back the same day in UTC.
    day: (r.day instanceof Date
      ? new Date(Date.UTC(r.day.getFullYear(), r.day.getMonth(), r.day.getDate()))
      : new Date(String(r.day).slice(0, 10) + "T00:00:00Z")
    ).toISOString(),
    created_at: r.created_at,
  }),
  task: (r: any) => ({
    id: r.id,
    card_id: r.card_id,
    text: r.text,
    done: r.done,
    position: r.position,
    created_at: r.created_at,
  }),
};
