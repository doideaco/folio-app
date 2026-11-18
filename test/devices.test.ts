// Device registration remembers the device's time zone (for local-time pushes),
// and an older app that doesn't send one keeps the zone already stored.
//
// Needs the local Postgres: FOLIO_DB_TESTS=1 npm test

import { test } from "node:test";
import assert from "node:assert/strict";

test("device time zone is stored and survives a re-register without one", { skip: !process.env.FOLIO_DB_TESTS }, async () => {
  const { q, applySchema } = await import("../src/db.js");
  const { buildApp } = await import("../src/app.js");
  const { issueSession } = await import("../src/auth.js");
  await applySchema();
  const tag = Math.random().toString(36).slice(2, 8);
  const [user] = await q<{ id: string }>(
    `INSERT INTO users (handle, apple_sub) VALUES ($1, $1) RETURNING id`, [`tz_${tag}`]);
  const auth = { authorization: `Bearer ${await issueSession(user.id)}` };
  const token = `test-token-${tag}`;
  const app = buildApp();
  await app.ready();
  try {
    const first = await app.inject({ method: "POST", url: "/devices", headers: auth,
      payload: { token, time_zone: "America/New_York" } });
    assert.equal(first.statusCode, 200);
    const older = await app.inject({ method: "POST", url: "/devices", headers: auth, payload: { token } });
    assert.equal(older.statusCode, 200);
    const [row] = await q<{ time_zone: string | null }>(`SELECT time_zone FROM device_tokens WHERE token = $1`, [token]);
    assert.equal(row.time_zone, "America/New_York");
  } finally {
    await q(`DELETE FROM device_tokens WHERE token = $1`, [token]);
    await app.close();
  }
});
