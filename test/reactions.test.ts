// Emoji reactions on saves: one per person per card, synced to the board, and a
// push to the saver on a first reaction.
//
// Run: npm test — set FOLIO_DB_TESTS=1 with the local Postgres up to include
// the database checks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createReactionBatcher } from "../src/pushBatch.js";

test("a reaction tells only the saver, with the emoji; a spree rolls up", () => {
  const sent: Array<{ user: string; body: string; extra: Record<string, string> }> = [];
  const queue: Array<() => void> = [];
  const batcher = createReactionBatcher({
    setTimer: (fn) => { queue.push(fn); },
    notify: async (user, _title, body, extra) => { sent.push({ user, body, extra }); },
  });
  const react = (cardId: string, cardTitle: string | null, emoji: string) => ({ boardId: "b", boardName: "Lisbon",
    reactorId: "jo", handle: "jo", saverId: "sam", cardId, cardTitle, emoji });
  batcher.add(react("c1", "Time Out Market", "❤️"));
  batcher.add(react("c2", "Pastéis de Belém", "🔥"));
  batcher.add(react("c3", null, "😂"));
  for (const fn of queue.splice(0)) fn();
  assert.deepEqual(sent.map((s) => s.user), ["sam", "sam"]);
  assert.equal(sent[0].body, "@jo ❤️ your save “Time Out Market”");
  assert.deepEqual(sent[0].extra, { type: "reaction", board_id: "b", card_id: "c1" });
  assert.equal(sent[1].body, "@jo reacted to 2 more of your saves");
});

test("react, change, sync and remove", { skip: !process.env.FOLIO_DB_TESTS }, async () => {
  const { q, applySchema } = await import("../src/db.js");
  const { buildApp } = await import("../src/app.js");
  const { issueSession } = await import("../src/auth.js");
  await applySchema();
  const tag = Math.random().toString(36).slice(2, 8);
  const user = async (name: string) =>
    (await q<{ id: string }>(`INSERT INTO users (handle, apple_sub) VALUES ($1, $1) RETURNING id`, [`${name}_${tag}`]))[0].id;
  const [saver, friend, outsider] = await Promise.all(["saver", "friend", "outsider"].map(user));
  const [board] = await q<{ id: string }>(
    `INSERT INTO boards (owner_id, name, kind) VALUES ($1, $2, 'shared') RETURNING id`, [saver, `Lisbon ${tag}`]);
  for (const u of [saver, friend]) await q(`INSERT INTO board_members (board_id, user_id) VALUES ($1, $2)`, [board.id, u]);
  const [card] = await q<{ id: string }>(
    `INSERT INTO cards (board_id, added_by, type, status, title) VALUES ($1, $2, 'place', 'ready', 'Time Out Market') RETURNING id`,
    [board.id, saver]);

  const app = buildApp();
  await app.ready();
  const as = async (u: string) => ({ authorization: `Bearer ${await issueSession(u)}` });
  try {
    // The saver's sync position before anything happens.
    const before = (await app.inject({ url: "/sync", headers: await as(saver) })).json();

    const first = await app.inject({ method: "PUT", url: `/cards/${card.id}/reaction`, headers: await as(friend), payload: { emoji: "❤️" } });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().emoji, "❤️");

    const changed = await app.inject({ method: "PUT", url: `/cards/${card.id}/reaction`, headers: await as(friend), payload: { emoji: "🔥" } });
    assert.equal(changed.json().id, first.json().id, "changing the emoji replaces, not adds");
    const [{ count }] = await q<{ count: string }>(`SELECT count(*) FROM card_reactions WHERE card_id = $1`, [card.id]);
    assert.equal(count, "1");

    const bad = await app.inject({ method: "PUT", url: `/cards/${card.id}/reaction`, headers: await as(friend), payload: { emoji: "💩" } });
    assert.equal(bad.statusCode, 422, "only the offered emoji");
    const stranger = await app.inject({ method: "PUT", url: `/cards/${card.id}/reaction`, headers: await as(outsider), payload: { emoji: "❤️" } });
    assert.equal(stranger.statusCode, 403, "only board members");

    // The saver's next sync carries the friend's reaction (and who they are).
    const synced = (await app.inject({ url: `/sync?since=${before.cursor}`, headers: await as(saver) })).json();
    assert.deepEqual(synced.reactions.map((r: any) => [r.card_id, r.user_id, r.emoji]), [[card.id, friend, "🔥"]]);
    assert.ok(synced.users.some((u: any) => u.id === friend));

    // Removing it syncs as a deletion.
    const removed = await app.inject({ method: "DELETE", url: `/cards/${card.id}/reaction`, headers: await as(friend) });
    assert.equal(removed.statusCode, 204);
    const after = (await app.inject({ url: `/sync?since=${synced.cursor}`, headers: await as(saver) })).json();
    assert.deepEqual(after.deleted.reactions, [first.json().id]);
  } finally {
    await app.close();
  }
});
