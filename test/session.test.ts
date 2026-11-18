// Session lifetime: year-long tokens judged by issue time, so lapsed tokens
// from the old 30-day lifetime keep working (and renew) instead of signing
// people out.
//
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { config } from "../src/config.js";
import { issueSession, verifySessionClaims, SESSION_TTL_SECONDS } from "../src/auth.js";

const secret = new TextEncoder().encode(config.SESSION_JWT_SECRET);
const day = 24 * 60 * 60;
const now = Math.floor(Date.now() / 1000);

/** A token shaped like the old ones: issued `ageDays` ago with a 30-day exp. */
function legacyToken(ageDays: number, key = secret): Promise<string> {
  const iat = now - ageDays * day;
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user-1")
    .setIssuedAt(iat)
    .setExpirationTime(iat + 30 * day)
    .sign(key);
}

test("a fresh session verifies", async () => {
  const token = await issueSession("user-1");
  const claims = await verifySessionClaims(token);
  assert.equal(claims.userId, "user-1");
});

test("a fresh session is still valid just under a year later", async () => {
  const token = await issueSession("user-1");
  const claims = await verifySessionClaims(token, now + SESSION_TTL_SECONDS - day);
  assert.equal(claims.userId, "user-1");
});

test("a lapsed 30-day token under a year old is still accepted", async () => {
  const claims = await verifySessionClaims(await legacyToken(90));
  assert.equal(claims.userId, "user-1");
});

test("a token over a year old is rejected", async () => {
  await assert.rejects(verifySessionClaims(await legacyToken(400)));
});

test("a token signed with another secret is rejected", async () => {
  const other = new TextEncoder().encode("not-the-secret");
  await assert.rejects(verifySessionClaims(await legacyToken(1, other)));
});

test("an older session gets a renewed token back; a fresh one doesn't", async () => {
  const { buildApp } = await import("../src/app.js");
  const { requireUserId, RENEWED_SESSION_HEADER } = await import("../src/auth.js");
  const app = buildApp();
  app.get("/_whoami", async (req) => ({ id: await requireUserId(req) }));
  await app.ready();
  try {
    const old = await app.inject({ url: "/_whoami", headers: { authorization: `Bearer ${await legacyToken(10)}` } });
    assert.equal(old.statusCode, 200);
    const renewed = old.headers[RENEWED_SESSION_HEADER];
    assert.equal(typeof renewed, "string");
    assert.equal((await verifySessionClaims(renewed as string)).userId, "user-1");

    const fresh = await app.inject({ url: "/_whoami", headers: { authorization: `Bearer ${await issueSession("user-1")}` } });
    assert.equal(fresh.statusCode, 200);
    assert.equal(fresh.headers[RENEWED_SESSION_HEADER], undefined);

    const none = await app.inject({ url: "/_whoami" });
    assert.equal(none.statusCode, 401);
  } finally {
    await app.close();
  }
});
