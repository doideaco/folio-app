// Notification controls (switch kinds off, mute a board) and the comment and
// vote pushes.
//
// Run: npm test — set FOLIO_DB_TESTS=1 with the local Postgres up to include
// the database checks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCommentBatcher, createVoteBatcher } from "../src/pushBatch.js";

function timers() {
  const queue: Array<() => void> = [];
  return { setTimer: (fn: () => void) => { queue.push(fn); }, fire: () => { for (const f of queue.splice(0)) f(); } };
}

test("a comment notifies the board with the card and the words", () => {
  const sent: Array<{ title: string; body: string; extra: Record<string, string> }> = [];
  const t = timers();
  const batcher = createCommentBatcher({
    setTimer: t.setTimer,
    notify: async (_b, _a, title, body, extra) => { sent.push({ title, body, extra }); },
  });
  batcher.add({ boardId: "b", boardName: "Lisbon", actorId: "jo", handle: "jo", cardId: "c",
    cardTitle: "Time Out Market", text: "love this, let's go Friday", imageURL: "https://img/x.jpg" });
  assert.equal(sent[0].title, "Lisbon");
  assert.equal(sent[0].body, "@jo on “Time Out Market”: love this, let's go Friday");
  assert.deepEqual(sent[0].extra, { board_id: "b", card_id: "c", image_url: "https://img/x.jpg" });
  for (let i = 0; i < 3; i++) batcher.add({ boardId: "b", boardName: "Lisbon", actorId: "jo", handle: "jo",
    cardId: "c", cardTitle: "Time Out Market", text: "more" });
  t.fire();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body, "@jo left 3 more comments on “Time Out Market”");
});

test("a vote tells only the saver, and a voting spree rolls up", () => {
  const sent: Array<{ user: string; body: string; extra: Record<string, string> }> = [];
  const t = timers();
  const batcher = createVoteBatcher({
    setTimer: t.setTimer,
    notify: async (user, _title, body, extra) => { sent.push({ user, body, extra }); },
  });
  const vote = (cardId: string, cardTitle: string) => ({ boardId: "b", boardName: "Dinner", voterId: "jo",
    handle: "jo", saverId: "sam", cardId, cardTitle });
  batcher.add(vote("c1", "Tartine"));
  batcher.add(vote("c2", "Ichiran"));
  batcher.add(vote("c3", "Blue Bottle"));
  t.fire();
  assert.deepEqual(sent.map((s) => s.user), ["sam", "sam"]);
  assert.equal(sent[0].body, "@jo backed your save “Tartine”");
  assert.equal(sent[0].extra.card_id, "c1");
  assert.equal(sent[1].body, "@jo backed 2 more of your saves");
});

test("settings, mutes and who gets each kind of push", { skip: !process.env.FOLIO_DB_TESTS }, async () => {
  const { q, applySchema } = await import("../src/db.js");
  const { buildApp } = await import("../src/app.js");
  const { issueSession } = await import("../src/auth.js");
  const { boardRecipientTokens, userRecipientTokens } = await import("../src/push.js");
  await applySchema();
  const tag = Math.random().toString(36).slice(2, 8);
  const user = async (name: string) =>
    (await q<{ id: string }>(`INSERT INTO users (handle, apple_sub) VALUES ($1, $1) RETURNING id`, [`${name}_${tag}`]))[0].id;
  const [actor, muter, picky, keen] = await Promise.all(["actor", "muter", "picky", "keen"].map(user));
  const [board] = await q<{ id: string }>(
    `INSERT INTO boards (owner_id, name, kind) VALUES ($1, $2, 'shared') RETURNING id`, [actor, `Trip ${tag}`]);
  for (const u of [actor, muter, picky, keen]) {
    await q(`INSERT INTO board_members (board_id, user_id) VALUES ($1, $2)`, [board.id, u]);
    await q(`INSERT INTO device_tokens (token, user_id) VALUES ($1, $2)`, [`tok-${u}`, u]);
  }

  const app = buildApp();
  await app.ready();
  const as = async (u: string) => ({ authorization: `Bearer ${await issueSession(u)}` });
  try {
    // Mute through the API; switch comments off through the API.
    assert.equal((await app.inject({ method: "PUT", url: `/boards/${board.id}/mute`, headers: await as(muter) })).statusCode, 200);
    const put = await app.inject({ method: "PUT", url: "/me/notifications", headers: await as(picky),
      payload: { disabled: ["comments", "comments", "digest"] } });
    assert.equal(put.statusCode, 200);
    assert.deepEqual(put.json().disabled.sort(), ["comments", "digest"]);
    const bad = await app.inject({ method: "PUT", url: "/me/notifications", headers: await as(picky),
      payload: { disabled: ["everything"] } });
    assert.equal(bad.statusCode, 422, "unknown kinds are rejected");

    const got = await app.inject({ method: "GET", url: "/me/notifications", headers: await as(muter) });
    assert.deepEqual(got.json(), { disabled: [], muted_board_ids: [board.id] });

    const tokens = async (kind: "saves" | "comments") => (await boardRecipientTokens(board.id, actor, kind)).sort();
    assert.deepEqual(await tokens("saves"), [`tok-${keen}`, `tok-${picky}`].sort(), "muted board → nothing; actor never");
    assert.deepEqual(await tokens("comments"), [`tok-${keen}`], "comments off → no comment pushes");

    // Personal pushes: kinds and board mutes apply; kind-less (invites) always send.
    assert.deepEqual(await userRecipientTokens(picky, "digest", null), []);
    assert.deepEqual(await userRecipientTokens(picky, "shopping", null), [`tok-${picky}`]);
    assert.deepEqual(await userRecipientTokens(muter, "decisions", board.id), [], "muted board's vote reminders");
    assert.deepEqual(await userRecipientTokens(muter, null, board.id), [`tok-${muter}`], "invites ignore mutes");

    // Unmute restores pushes.
    assert.equal((await app.inject({ method: "DELETE", url: `/boards/${board.id}/mute`, headers: await as(muter) })).statusCode, 200);
    assert.ok((await tokens("saves")).includes(`tok-${muter}`));

    // Only members can mute a board.
    const stranger = await user("stranger");
    assert.equal((await app.inject({ method: "PUT", url: `/boards/${board.id}/mute`, headers: await as(stranger) })).statusCode, 403);
  } finally {
    await q(`DELETE FROM device_tokens WHERE token LIKE $1`, [`tok-%`]);
    await app.close();
  }
});
