// The weekly digest goes out at 9am on Sunday in each person's own time zone,
// not 9am UTC (which is 4am in New York and 1am in Los Angeles).
//
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { digestWeek, localClock } from "../src/digest.js";

// Sunday 16 Nov 2025 at the given UTC hour.
const sundayUTC = (hour: number) => new Date(Date.UTC(2025, 10, 16, hour, 30));

test("London: 9am local on Sunday (GMT in November) is digest time", () => {
  assert.equal(digestWeek(sundayUTC(9), "Europe/London"), "2025-11-16");
  assert.equal(digestWeek(sundayUTC(8), "Europe/London"), null);
});

test("New York gets it at its own 9am, not 4am", () => {
  assert.equal(digestWeek(sundayUTC(9), "America/New_York"), null, "9am UTC is 4am in New York");
  assert.equal(digestWeek(sundayUTC(14), "America/New_York"), "2025-11-16");
});

test("Los Angeles at 9am Pacific", () => {
  assert.equal(digestWeek(sundayUTC(17), "America/Los_Angeles"), "2025-11-16");
});

test("ahead of UTC: Sydney's Sunday 9am is Saturday night UTC", () => {
  const saturday22UTC = new Date(Date.UTC(2025, 10, 15, 22, 30));
  assert.equal(digestWeek(saturday22UTC, "Australia/Sydney"), "2025-11-16");
});

test("half-hour zones work (India)", () => {
  const sunday0330UTC = new Date(Date.UTC(2025, 10, 16, 3, 45)); // 09:15 IST
  assert.equal(digestWeek(sunday0330UTC, "Asia/Kolkata"), "2025-11-16");
});

test("no zone or a bad zone falls back to UTC", () => {
  assert.equal(digestWeek(sundayUTC(9), null), "2025-11-16");
  assert.equal(digestWeek(sundayUTC(9), "Not/AZone"), "2025-11-16");
  assert.deepEqual(localClock(sundayUTC(9), "Not/AZone"), { weekday: 0, hour: 9, date: "2025-11-16" });
});

test("not on other days", () => {
  const monday9UTC = new Date(Date.UTC(2025, 10, 17, 9, 0));
  assert.equal(digestWeek(monday9UTC, "Europe/London"), null);
});
