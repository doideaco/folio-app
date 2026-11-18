import { SignJWT, jwtVerify, createRemoteJWKSet } from "jose";
import type { FastifyRequest } from "fastify";
import { config } from "./config.js";
import { unauthorized } from "./errors.js";

const sessionSecret = new TextEncoder().encode(config.SESSION_JWT_SECRET);

/**
 * Sessions are good for a year from issue and renew as they're used, so anyone
 * who opens Folio at least once a year stays signed in until they sign out.
 */
export const SESSION_TTL_SECONDS = 365 * 24 * 60 * 60;
/** Once a token is this old, authenticated responses carry a fresh one. */
export const SESSION_RENEW_AFTER_SECONDS = 7 * 24 * 60 * 60;
/** Response header carrying a renewed session token for the client to store. */
export const RENEWED_SESSION_HEADER = "x-folio-session";

/** Renewed tokens minted while handling a request, sent back by an onSend hook. */
export const renewedSessions = new WeakMap<FastifyRequest, string>();

export async function issueSession(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS)
    .sign(sessionSecret);
}

/**
 * Validity is judged on when the token was issued, not its `exp`: tokens from
 * the old 30-day lifetime that have since lapsed are still accepted (and get
 * renewed) while they're under a year old, so the switch signs nobody out.
 */
export async function verifySessionClaims(
  token: string,
  now: number = Math.floor(Date.now() / 1000)
): Promise<{ userId: string; issuedAt: number }> {
  try {
    const { payload } = await jwtVerify(token, sessionSecret, {
      clockTolerance: SESSION_TTL_SECONDS,
      currentDate: new Date(now * 1000),
    });
    if (!payload.sub) throw new Error("no sub");
    if (typeof payload.iat !== "number" || now - payload.iat > SESSION_TTL_SECONDS) {
      throw new Error("session too old");
    }
    return { userId: payload.sub, issuedAt: payload.iat };
  } catch {
    throw unauthorized("invalid session token");
  }
}

export async function verifySession(token: string): Promise<string> {
  return (await verifySessionClaims(token)).userId;
}

const appleJWKS = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

/**
 * Verify an Apple identity token; returns the stable Apple `sub` plus the
 * `email` claim when present. Apple only includes email on the *first*
 * authorization (and only if the user agrees to share it — it may be a private
 * relay address), so email is best-effort and often absent on later sign-ins.
 */
export async function verifyAppleToken(
  identityToken: string
): Promise<{ sub: string; email?: string }> {
  try {
    const { payload } = await jwtVerify(identityToken, appleJWKS, {
      issuer: "https://appleid.apple.com",
      audience: config.APPLE_CLIENT_ID,
    });
    if (!payload.sub) throw new Error("no sub");
    const email = typeof payload.email === "string" ? payload.email : undefined;
    return { sub: payload.sub, email };
  } catch {
    throw unauthorized("invalid Apple identity token");
  }
}

/** Extract and verify the bearer token from a request. */
export async function requireUserId(req: FastifyRequest): Promise<string> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw unauthorized("missing bearer token");
  const { userId, issuedAt } = await verifySessionClaims(header.slice("Bearer ".length));
  if (Math.floor(Date.now() / 1000) - issuedAt > SESSION_RENEW_AFTER_SECONDS && !renewedSessions.has(req)) {
    renewedSessions.set(req, await issueSession(userId));
  }
  return userId;
}
