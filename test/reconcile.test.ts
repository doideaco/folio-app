// Unit tests for the pure reconciliation engine.
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { referenceOf, reconcileKey, mergeRecords, diffRecords, type Rec } from "../src/inbound/reconcile.js";
import { parseInboundEmail, type InboundEmail } from "../src/inbound/parse.js";

const samplesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "samples");

function recOf(file: string): Rec {
  const raw = readFileSync(join(samplesDir, file), "utf8");
  const subject = raw.match(/^Subject:\s*(.+)$/mi)?.[1]?.trim() ?? "";
  const email: InboundEmail = { to: "x@folioinbox.me", from: "me <me@x.com>", subject: `Fwd: ${subject}`, text: raw };
  return parseInboundEmail(email, { now: new Date("2026-06-01") }).extracted as Rec;
}

// ---- key extraction --------------------------------------------------------

test("reconcileKey keys flights on their booking reference", () => {
  const rec = recOf("ba-changed-zxrq9t.txt");
  assert.equal(referenceOf(rec), "ZXRQ9T");
  assert.equal(reconcileKey(rec), "flight:ZXRQ9T");
});

test("order and shipment of the same order number share a purchase key", () => {
  const order: Rec = { record_kind: "order", fields: [{ label: "Order #", value: "72423796" }] };
  const shipment: Rec = { record_kind: "shipment", fields: [{ label: "Order #", value: "72423796" }] };
  assert.equal(reconcileKey(order), reconcileKey(shipment));
  assert.equal(reconcileKey(order), "purchase:72423796");
});

test("no reference ⇒ no key (never reconcile on weak signals)", () => {
  assert.equal(reconcileKey({ record_kind: "flight", title: "Some trip", fields: [] }), null);
});

test("different bookings do not share a key", () => {
  assert.notEqual(reconcileKey(recOf("ba-changed-zxrq9t.txt")), reconcileKey(recOf("ba-confirm-xp3lkk.txt")));
});

// ---- merge / projection ----------------------------------------------------

const original: Rec = {
  record_kind: "flight", title: "✈️ British Airways", status: "Confirmed",
  date: "2026-02-21T12:50:00.000Z", date_label: "Departs",
  fields: [
    { label: "Booking ref", value: "ZXRQ9T", copyable: true },
    { label: "Cabin", value: "World Traveller Plus" },
    { label: "Checked baggage", value: "2 x 23 kg" },
  ],
};
const changed: Rec = {
  record_kind: "flight", title: "✈️ British Airways", status: "Booking updated",
  date: "2026-02-21T12:50:00.000Z", date_label: "Departs",
  amount: "£550.00",
  fields: [
    { label: "Booking ref", value: "ZXRQ9T", copyable: true },
    { label: "Cabin", value: "Club World" },
    { label: "Checked baggage", value: "2 x 32 kg" },
  ],
};

test("merge folds sources; later scalars win, fields merge by label", () => {
  const merged = mergeRecords([
    { date: "2025-12-16", rec: original },
    { date: "2026-01-21", rec: changed },
  ]);
  assert.equal(merged.status, "Booking updated");        // latest scalar
  assert.equal(merged.amount, "£550.00");                // only on the change
  const cabin = merged.fields.find((f: any) => f.label === "Cabin")?.value;
  assert.equal(cabin, "Club World");                     // latest field value
  const ref = merged.fields.find((f: any) => f.label === "Booking ref");
  assert.equal(ref.copyable, true);                      // field object preserved
  assert.equal(merged.fields.length, 3);                 // union, not duplicated
});

test("merge is order-independent (change before original = same projection)", () => {
  const a = mergeRecords([{ date: "2025-12-16", rec: original }, { date: "2026-01-21", rec: changed }]);
  const b = mergeRecords([{ date: "2026-01-21", rec: changed }, { date: "2025-12-16", rec: original }]);
  assert.deepEqual(a, b);
  assert.equal(a.status, "Booking updated"); // the later-dated source still wins
});

test("omission does not delete — a sparse later email keeps prior detail", () => {
  const sparse: Rec = { record_kind: "flight", status: "Booking updated", fields: [{ label: "Booking ref", value: "ZXRQ9T" }] };
  const merged = mergeRecords([{ date: "2025-12-16", rec: original }, { date: "2026-01-21", rec: sparse }]);
  assert.equal(merged.fields.find((f: any) => f.label === "Cabin")?.value, "World Traveller Plus");
  assert.equal(merged.status, "Booking updated");
});

// ---- diff ------------------------------------------------------------------

test("diff surfaces the meaningful changes, ignores the reference", () => {
  const before = mergeRecords([{ date: "2025-12-16", rec: original }]);
  const after = mergeRecords([{ date: "2025-12-16", rec: original }, { date: "2026-01-21", rec: changed }]);
  const lines = diffRecords(before, after);
  assert.ok(lines.some((l) => /Cabin: World Traveller Plus → Club World/.test(l)), lines.join(" | "));
  assert.ok(lines.some((l) => /Checked baggage: .*23 kg → .*32 kg/.test(l)), lines.join(" | "));
  assert.ok(lines.some((l) => /Status: Confirmed → Booking updated/.test(l)), lines.join(" | "));
  assert.ok(lines.some((l) => /Amount:.*550/.test(l)), lines.join(" | "));
  assert.ok(!lines.some((l) => /ZXRQ9T/.test(l)), "reference must not appear as a change");
});

test("diff is empty for the first email", () => {
  assert.deepEqual(diffRecords(null, original), []);
});
