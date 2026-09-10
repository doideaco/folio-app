import { SignJWT, jwtVerify, createRemoteJWKSet } from "jose";
import type { FastifyRequest } from "fastify";
import { config } from "./config.js";
import { unauthorized } from "./errors.js";

const sessionSecret = new TextEncoder().encode(config.SESSION_JWT_SECRET);

export async function issueSession(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(sessionSecret);
}

export async function verifySession(token: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, sessionSecret);
    if (!payload.sub) throw new Error("no sub");
    return payload.sub;
  } catch {
    throw unauthorized("invalid session token");
  }
}

const appleJWKS = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

/** Verify an Apple identity token; returns the stable Apple `sub`. */
export async function verifyAppleToken(identityToken: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(identityToken, appleJWKS, {
      issuer: "https://appleid.apple.com",
      audience: config.APPLE_CLIENT_ID,
    });
    if (!payload.sub) throw new Error("no sub");
    return payload.sub;
  } catch {
    throw unauthorized("invalid Apple identity token");
  }
}

/** Extract and verify the bearer token from a request. */
export async function requireUserId(req: FastifyRequest): Promise<string> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw unauthorized("missing bearer token");
  return verifySession(header.slice("Bearer ".length));
}
