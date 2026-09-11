import type { FastifyInstance } from "fastify";
import { q, serialize } from "../db.js";
import { requireUserId } from "../auth.js";
import { encodeCursor, decodeCursor } from "../cursor.js";

const PAGE = 500;

export async function syncRoutes(app: FastifyInstance) {
  // GET /sync?since=cursor — changes to the user's boards since the cursor.
  app.get("/sync", async (req) => {
    const userId = await requireUserId(req);
    const since = decodeCursor((req.query as { since?: string }).since);

    // Boards the user can see.
    const boardRows = await q<{ board_id: string }>(
      "SELECT board_id FROM board_members WHERE user_id = $1",
      [userId]
    );
    const userBoards = boardRows.map((r) => r.board_id);
    if (userBoards.length === 0) {
      return emptyResponse(since);
    }

    const changes = await q<any>(
      `SELECT seq, entity, entity_id, op FROM change_log
       WHERE seq > $1 AND board_id = ANY($2::uuid[])
       ORDER BY seq LIMIT ${PAGE}`,
      [String(since), userBoards]
    );

    if (changes.length === 0) {
      return emptyResponse(since);
    }

    const maxSeq = changes[changes.length - 1].seq;
    const hasMore = changes.length === PAGE;

    // Partition ids per entity and op.
    const boardUp = new Set<string>();
    const boardDel = new Set<string>();
    const cardUp = new Set<string>();
    const cardDel = new Set<string>();
    const commentUp = new Set<string>();
    const commentDel = new Set<string>();
    const ratingUp = new Set<string>();
    const ratingDel = new Set<string>();
    const faveUp = new Set<string>();
    const faveDel = new Set<string>();
    const memberBoards = new Set<string>();

    for (const c of changes) {
      const del = c.op === "delete";
      switch (c.entity) {
        case "board":
          (del ? boardDel : boardUp).add(c.entity_id);
          break;
        case "card":
          (del ? cardDel : cardUp).add(c.entity_id);
          break;
        case "comment":
          (del ? commentDel : commentUp).add(c.entity_id);
          break;
        case "rating":
          (del ? ratingDel : ratingUp).add(c.entity_id);
          break;
        case "fave":
          (del ? faveDel : faveUp).add(c.entity_id);
          break;
        case "board_member":
          memberBoards.add(c.entity_id); // entity_id is the board id
          break;
      }
    }

    const boards = boardUp.size
      ? (await q<any>("SELECT * FROM boards WHERE id = ANY($1::uuid[])", [[...boardUp]])).map(serialize.board)
      : [];
    const cards = cardUp.size
      ? (await q<any>("SELECT * FROM cards WHERE id = ANY($1::uuid[])", [[...cardUp]])).map(serialize.card)
      : [];
    const comments = commentUp.size
      ? (await q<any>("SELECT * FROM card_comments WHERE id = ANY($1::uuid[])", [[...commentUp]])).map(serialize.comment)
      : [];
    const ratings = ratingUp.size
      ? (await q<any>("SELECT * FROM card_ratings WHERE id = ANY($1::uuid[])", [[...ratingUp]])).map(serialize.rating)
      : [];
    const faves = faveUp.size
      ? (await q<any>("SELECT * FROM card_faves WHERE id = ANY($1::uuid[])", [[...faveUp]])).map(serialize.fave)
      : [];
    const members = memberBoards.size
      ? (await q<any>("SELECT * FROM board_members WHERE board_id = ANY($1::uuid[])", [[...memberBoards]])).map(serialize.member)
      : [];

    // Users referenced by anything we're returning.
    const userIds = new Set<string>();
    for (const b of boards) userIds.add(b.owner_id);
    for (const c of cards) userIds.add(c.added_by);
    for (const m of members) userIds.add(m.user_id);
    for (const c of comments) userIds.add(c.user_id);
    for (const r of ratings) userIds.add(r.user_id);
    for (const f of faves) userIds.add(f.user_id);
    const users = userIds.size
      ? (await q<any>("SELECT * FROM users WHERE id = ANY($1::uuid[])", [[...userIds]])).map(serialize.user)
      : [];

    return {
      cursor: encodeCursor(maxSeq),
      has_more: hasMore,
      boards,
      cards,
      comments,
      ratings,
      faves,
      members,
      users,
      deleted: {
        cards: [...cardDel],
        comments: [...commentDel],
        ratings: [...ratingDel],
        faves: [...faveDel],
        boards: [...boardDel],
      },
    };
  });
}

function emptyResponse(since: bigint) {
  return {
    cursor: encodeCursor(since),
    has_more: false,
    boards: [],
    cards: [],
    comments: [],
    ratings: [],
    faves: [],
    members: [],
    users: [],
    deleted: { cards: [], comments: [], ratings: [], faves: [], boards: [] },
  };
}
