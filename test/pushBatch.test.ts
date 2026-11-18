// A burst of saves to a shared board should cost the board's members at most
// two notifications: one straight away, one roll-up — never one per card.
//
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSaveBatcher, type SaveEvent } from "../src/pushBatch.js";

type Sent = { boardId: string; actorId: string; title: string; body: string; extra: Record<string, string> };

function harness() {
  const sent: Sent[] = [];
  const timers: Array<() => void> = [];
  const batcher = createSaveBatcher({
    windowMs: 1000,
    notify: async (boardId, actorId, title, body, extra) => {
      sent.push({ boardId, actorId, title, body, extra });
    },
    setTimer: (fn) => { timers.push(fn); },
  });
  const fireTimers = () => { for (const fn of timers.splice(0)) fn(); };
  return { sent, batcher, fireTimers };
}

const save = (over: Partial<SaveEvent> = {}): SaveEvent => ({
  boardId: "lisbon", boardName: "Lisbon", actorId: "sam", handle: "sam",
  cardId: "c1", cardTitle: "Time Out Market", ...over,
});

test("a single save notifies immediately, naming the card", () => {
  const { sent, batcher, fireTimers } = harness();
  batcher.add(save());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, "Lisbon");
  assert.equal(sent[0].body, "@sam added “Time Out Market”");
  assert.deepEqual(sent[0].extra, { board_id: "lisbon", card_id: "c1" });
  fireTimers();
  assert.equal(sent.length, 1, "no follow-up when nothing else was added");
});

test("a burst becomes one immediate push plus one roll-up", () => {
  const { sent, batcher, fireTimers } = harness();
  for (let i = 1; i <= 8; i++) batcher.add(save({ cardId: `c${i}`, cardTitle: `Place ${i}` }));
  assert.equal(sent.length, 1);
  fireTimers();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body, "@sam added 7 more saves");
  assert.deepEqual(sent[1].extra, { board_id: "lisbon" }, "several saves open the board");
});

test("one extra save rolls up to that card", () => {
  const { sent, batcher, fireTimers } = harness();
  batcher.add(save({ cardId: "c1" }));
  batcher.add(save({ cardId: "c2" }));
  fireTimers();
  assert.equal(sent[1].body, "@sam added another save");
  assert.deepEqual(sent[1].extra, { board_id: "lisbon", card_id: "c2" });
});

test("different people and boards batch separately", () => {
  const { sent, batcher, fireTimers } = harness();
  batcher.add(save({ actorId: "sam", handle: "sam" }));
  batcher.add(save({ actorId: "jo", handle: "jo", cardId: "c2" }));
  batcher.add(save({ boardId: "rome", boardName: "Rome", cardId: "c3" }));
  assert.equal(sent.length, 3, "each first save is immediate");
  fireTimers();
  assert.equal(sent.length, 3);
});

test("after the window closes, the next save is immediate again", () => {
  const { sent, batcher, fireTimers } = harness();
  batcher.add(save({ cardId: "c1" }));
  fireTimers();
  batcher.add(save({ cardId: "c2", cardTitle: null }));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body, "@sam added a save", "untitled links fall back to a generic line");
  assert.equal(batcher.pendingCount, 1);
});

test("long titles are trimmed", () => {
  const { sent, batcher } = harness();
  batcher.add(save({ cardTitle: "x".repeat(200) }));
  assert.ok(sent[0].body.length < 100);
  assert.ok(sent[0].body.endsWith("…”"));
});
