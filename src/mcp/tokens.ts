import crypto from "node:crypto";
import { q, one } from "../db.js";

const PREFIX = "folio_pat_";

export interface TokenPrincipal {
  userId: string;
  scope: "read" | "read_write";
  tokenId: string;
}

function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/** Mint a new PAT. The raw token is returned once (never stored) — only its hash. */
export async function createToken(
  userId: string,
  label: string | null,
  scope: "read" | "read_write"
): Promise<{ id: string; token: string }> {
  const raw = PREFIX + crypto.randomBytes(24).toString("base64url");
  const row = await one<{ id: string }>(
    `INSERT INTO mcp_tokens (user_id, token_hash, label, scope) VALUES ($1,$2,$3,$4) RETURNING id`,
    [userId, hashToken(raw), label, scope]
  );
  return { id: row!.id, token: raw };
}

/** Resolve a raw PAT to its principal, bumping last_used_at. Null if unknown. */
export async function verifyToken(raw: string): Promise<TokenPrincipal | null> {
  if (!raw.startsWith(PREFIX)) return null;
  const row = await one<{ id: string; user_id: string; scope: "read" | "read_write" }>(
    `SELECT id, user_id, scope FROM mcp_tokens WHERE token_hash = $1`,
    [hashToken(raw)]
  );
  if (!row) return null;
  void q(`UPDATE mcp_tokens SET last_used_at = now() WHERE id = $1`, [row.id]);
  return { userId: row.user_id, scope: row.scope, tokenId: row.id };
}

export async function listTokens(userId: string) {
  return q(
    `SELECT id, label, scope, created_at, last_used_at
       FROM mcp_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
}

export async function revokeToken(userId: string, id: string): Promise<boolean> {
  const rows = await q(`DELETE FROM mcp_tokens WHERE id = $1 AND user_id = $2 RETURNING id`, [id, userId]);
  return rows.length > 0;
}
