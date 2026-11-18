// "Voting closes soon" reminders: wording, and (with a database) who gets one.
//
// Run: npm test   — set FOLIO_DB_TESTS=1 with the local Postgres up to include
// the database checks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { closingPhrase, runVoteReminderSweep } from "../src/voteReminders.js";

test("closing phrase reads naturally", () => {
  assert.equal(closingPhrase(2 * 60 * 60 * 1000), "in 2 hours");
  assert.equal(closingPhrase(100 * 60 * 1000), "in 2 hours");
  assert.equal(closingPhrase(60 * 60 * 1000), "in 1 hour");
  assert.equal(closingPhrase(40 * 60 * 1000), "in 40 minutes");
  assert.equal(closingPhrase(30 * 1000), "in 1 minute");
});

test("reminds only members who haven't voted, once per deadline", { skip: !process.env.FOLIO_DB_TESTS }, async () => {
  const { q, applySchema } = await import("../src/db.js");
  await applySchema();
  const tag = Math.random().toString(36).slice(2, 8);
  const [owner, voter, quiet] = await Promise.all(["owner", "voter", "quiet"].map(async (name) =>
    (await q<{ id: string }>(`INSERT INTO users (handle, apple_sub) VALUES ($1, $1) RETURNING id`, [`${name}_${tag}`]))[0].id));
  const deadline = new Date(Date.now() + 90 * 60 * 1000);
  const [board] = await q<{ id: string }>(
    `INSERT INTO boards (owner_id, name, kind, decide_by, updated_at) VALUES ($1, $2, 'shared', $3, now() - interval '1 hour') RETURNING id`,
    [owner, `Dinner ${tag}`, deadline.toISOString()]);
  for (const u of [owner, voter, quiet]) {
    await q(`INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, $3)`, [board.id, u, u === owner ? "owner" : "member"]);
  }
  const [card] = await q<{ id: string }>(
    `INSERT INTO cards (board_id, added_by, type, status, title) VALUES ($1, $2, 'place', 'ready', 'Tartine') RETURNING id`,
    [board.id, owner]);
  await q(`INSERT INTO card_votes (card_id, user_id) VALUES ($1, $2)`, [card.id, voter]);

  const sent: Array<{ user: string; body: string; timeSensitive?: boolean }> = [];
  const notify = async (user: string, _t: string, body: string, _e: Record<string, string> = {}, o: { timeSensitive?: boolean } = {}) => {
    sent.push({ user, body, timeSensitive: o.timeSensitive });
    return true;
  };

  await runVoteReminderSweep(new Date(), notify, true);
  const mine = sent.filter((s) => [owner, voter, quiet].includes(s.user));
  assert.deepEqual(mine.map((s) => s.user).sort(), [owner, quiet].sort(), "the member who voted isn't nagged");
  assert.ok(mine.every((s) => s.timeSensitive));
  assert.match(mine[0].body, /^Voting closes in (1 hour|2 hours) — you haven’t voted yet/);

  sent.length = 0;
  await runVoteReminderSweep(new Date(), notify, true);
  assert.equal(sent.filter((s) => [owner, voter, quiet].includes(s.user)).length, 0, "only once per deadline");

  // A freshly set deadline isn't reminded straight away.
  const [fresh] = await q<{ id: string }>(
    `INSERT INTO boards (owner_id, name, kind, decide_by) VALUES ($1, $2, 'shared', $3) RETURNING id`,
    [owner, `Fresh ${tag}`, deadline.toISOString()]);
  await q(`INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'owner')`, [fresh.id, owner]);
  await runVoteReminderSweep(new Date(), notify, true);
  assert.equal(sent.length, 0, "no instant 'closes soon' when the vote was just started");
});
