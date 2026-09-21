import { q, one } from "../db.js";
import { runExtraction } from "../extraction.js";
import type { TokenPrincipal } from "./tokens.js";

// The board ids a principal may see over MCP: their memberships, minus any board
// marked private (secret / Face-ID boards are never exposed to AI tools).
async function visibleBoardIds(userId: string): Promise<string[]> {
  const rows = await q<{ id: string }>(
    `SELECT id FROM boards
      WHERE id IN (SELECT board_id FROM board_members WHERE user_id = $1)
        AND private = false`,
    [userId]
  );
  return rows.map((r) => r.id);
}

function cardOut(r: any) {
  return {
    id: r.id,
    title: r.title,
    board: r.board_name,
    type: r.type,
    status: r.status,
    url: r.source_url,
    note: r.user_note,
    date: r.event_at,
    created_at: r.created_at,
  };
}

export async function listBoards(p: TokenPrincipal) {
  const rows = await q<any>(
    `SELECT b.id, b.name, b.emoji, b.kind,
            (SELECT count(*) FROM cards c WHERE c.board_id = b.id) AS card_count
       FROM boards b
      WHERE b.id IN (SELECT board_id FROM board_members WHERE user_id = $1)
        AND b.private = false
      ORDER BY b.updated_at DESC`,
    [p.userId]
  );
  return {
    boards: rows.map((b) => ({
      id: b.id, name: b.name, emoji: b.emoji, kind: b.kind, card_count: Number(b.card_count),
    })),
  };
}

export async function searchSaves(p: TokenPrincipal, args: any) {
  const ids = await visibleBoardIds(p.userId);
  if (ids.length === 0) return { saves: [] };
  const limit = Math.min(Math.max(Number(args?.limit ?? 20), 1), 100);
  const conds: string[] = [`c.board_id = ANY($1::uuid[])`];
  const vals: unknown[] = [ids];
  if (args?.board) {
    vals.push(String(args.board));
    conds.push(`(b.id::text = $${vals.length} OR lower(b.name) = lower($${vals.length}))`);
  }
  if (args?.type) {
    vals.push(String(args.type));
    conds.push(`c.type = $${vals.length}`);
  }
  if (args?.query) {
    vals.push(`%${String(args.query)}%`);
    conds.push(`(c.title ILIKE $${vals.length} OR c.caption ILIKE $${vals.length} OR c.user_note ILIKE $${vals.length})`);
  }
  vals.push(limit);
  const rows = await q<any>(
    `SELECT c.*, b.name AS board_name
       FROM cards c JOIN boards b ON b.id = c.board_id
      WHERE ${conds.join(" AND ")}
      ORDER BY c.created_at DESC
      LIMIT $${vals.length}`,
    vals
  );
  return { saves: rows.map(cardOut) };
}

export async function getCard(p: TokenPrincipal, args: any) {
  const ids = await visibleBoardIds(p.userId);
  const row = await one<any>(
    `SELECT c.*, b.name AS board_name
       FROM cards c JOIN boards b ON b.id = c.board_id
      WHERE c.id = $1 AND c.board_id = ANY($2::uuid[])`,
    [args?.id, ids]
  );
  if (!row) return { error: "not_found" };
  return { ...cardOut(row), caption: row.caption, thumb_url: row.thumb_url, extracted: row.extracted ?? null };
}

export async function getAgenda(p: TokenPrincipal, args: any) {
  const ids = await visibleBoardIds(p.userId);
  if (ids.length === 0) return { agenda: [] };
  const limit = Math.min(Math.max(Number(args?.limit ?? 10), 1), 100);
  const rows = await q<any>(
    `SELECT c.*, b.name AS board_name
       FROM cards c JOIN boards b ON b.id = c.board_id
      WHERE c.board_id = ANY($1::uuid[])
        AND c.event_at IS NOT NULL
        AND c.event_at >= now() - interval '1 day'
      ORDER BY c.event_at ASC
      LIMIT $2`,
    [ids, limit]
  );
  return { agenda: rows.map(cardOut) };
}

export async function saveLink(p: TokenPrincipal, args: any) {
  const url = String(args?.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return { error: "a valid http(s) url is required" };
  const ids = await visibleBoardIds(p.userId);

  let boardId: string | null;
  if (args?.board) {
    const b = await one<{ id: string }>(
      `SELECT id FROM boards WHERE id = ANY($1::uuid[]) AND (id::text = $2 OR lower(name) = lower($2))`,
      [ids, String(args.board)]
    );
    boardId = b?.id ?? null;
    if (!boardId) return { error: "board not found" };
  } else {
    const b = await one<{ id: string }>(
      `SELECT id FROM boards WHERE id = ANY($1::uuid[]) ORDER BY updated_at DESC LIMIT 1`,
      [ids]
    );
    boardId = b?.id ?? null;
    if (!boardId) return { error: "no board to save into — create one first" };
  }

  const card = await one<any>(
    `INSERT INTO cards (board_id, added_by, source_url, source_kind, type, status, user_note)
     VALUES ($1,$2,$3,'post','other','pending',$4) RETURNING *`,
    [boardId, p.userId, url, args?.note ?? null]
  );
  await q(
    `INSERT INTO card_extraction_state (card_id, next_stage) VALUES ($1,'fetch') ON CONFLICT (card_id) DO NOTHING`,
    [card!.id]
  );
  void runExtraction(card!.id);
  return { id: card!.id, board_id: boardId, status: "pending" };
}

export async function createBoard(p: TokenPrincipal, args: any) {
  const name = String(args?.name ?? "").trim();
  if (!name) return { error: "name is required" };
  const board = await one<any>(
    `INSERT INTO boards (owner_id, name, emoji, kind) VALUES ($1,$2,$3,'solo') RETURNING *`,
    [p.userId, name, args?.emoji ?? null]
  );
  await q(
    `INSERT INTO board_members (board_id, user_id, role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING`,
    [board!.id, p.userId]
  );
  return { id: board!.id, name: board!.name, emoji: board!.emoji };
}
