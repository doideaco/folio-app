import http2 from "node:http2";
import { SignJWT, importPKCS8 } from "jose";
import { config } from "./config.js";
import { q } from "./db.js";
import { createCommentBatcher, createReactionBatcher, createSaveBatcher, createVoteBatcher } from "./pushBatch.js";

// Push is a no-op until the APNs key trio (key id, team id, .p8) is configured.
export const pushEnabled = Boolean(config.APNS_KEY_ID && config.APNS_TEAM_ID && config.APNS_KEY);

const apnsHost = () =>
  config.APNS_ENV === "sandbox"
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";

// APNs provider tokens are valid ~1h; cache and refresh every 50 minutes.
let cached: { jwt: string; at: number } | null = null;
async function providerToken(): Promise<string> {
  const now = Date.now();
  if (cached && now - cached.at < 50 * 60 * 1000) return cached.jwt;
  const key = await importPKCS8(config.APNS_KEY!.replace(/\\n/g, "\n"), "ES256");
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: config.APNS_KEY_ID! })
    .setIssuer(config.APNS_TEAM_ID!)
    .setIssuedAt()
    .sign(key);
  cached = { jwt, at: now };
  return jwt;
}

async function sendToToken(deviceToken: string, payload: object): Promise<number> {
  const jwt = await providerToken();
  return new Promise((resolve) => {
    const client = http2.connect(apnsHost());
    client.on("error", () => resolve(0));
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": config.APNS_BUNDLE_ID,
      "apns-push-type": "alert",
      "content-type": "application/json",
    });
    let status = 0;
    req.on("response", (h) => { status = Number(h[":status"]) || 0; });
    req.on("end", () => { client.close(); resolve(status); });
    req.on("error", () => { client.close(); resolve(0); });
    req.end(JSON.stringify(payload));
  });
}

/** Diagnostic: send a *silent* background push (no banner) to a token and return
 *  the raw APNs status — without pruning. 200 = ok, 400 = BadDeviceToken (usually
 *  an APNS_ENV mismatch), 403 = bad key/team, 410 = unregistered. Never throws. */
export async function probeToken(deviceToken: string): Promise<{ status: number; reason?: string }> {
  const jwt = await providerToken();
  return new Promise((resolve) => {
    const client = http2.connect(apnsHost());
    client.on("error", () => resolve({ status: 0, reason: "connect_error" }));
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": config.APNS_BUNDLE_ID,
      "apns-push-type": "background",
      "apns-priority": "5",
      "content-type": "application/json",
    });
    let status = 0;
    let bodyText = "";
    req.on("response", (h) => { status = Number(h[":status"]) || 0; });
    req.on("data", (chunk) => { bodyText += chunk; });
    req.on("end", () => {
      client.close();
      let reason: string | undefined;
      try { reason = bodyText ? JSON.parse(bodyText).reason : undefined; } catch { /* ignore */ }
      resolve({ status, reason });
    });
    req.on("error", () => { client.close(); resolve({ status: 0, reason: "request_error" }); });
    req.end(JSON.stringify({ aps: { "content-available": 1 } }));
  });
}

/** What a notification is about. Each kind can be switched off in the app's
 *  Settings; board-related kinds also respect a muted board. Invites and
 *  diagnostics pass no kind and always send. */
export const NOTIFICATION_KINDS = ["saves", "comments", "decisions", "reactions", "shopping", "digest"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

function payloadFor(
  title: string,
  body: string,
  extra: Record<string, string>,
  thread: string,
  options: { timeSensitive?: boolean } = {}
): object {
  return {
    aps: {
      alert: { title, body },
      sound: "default",
      "thread-id": thread,
      // Time Sensitive can break through Focus — reserved for deadlines.
      ...(options.timeSensitive ? { "interruption-level": "time-sensitive" } : {}),
      // Lets the app's notification extension attach the card's thumbnail.
      ...(extra.image_url ? { "mutable-content": 1 } : {}),
    },
    ...extra,
  };
}

/** A user's device tokens for this push — none if they've switched the kind
 *  off, or (for a board-related kind) muted that board. No kind = always. */
export async function userRecipientTokens(
  userId: string, kind: NotificationKind | null, boardId: string | null
): Promise<string[]> {
  const rows = await q<{ token: string }>(
    `SELECT dt.token FROM device_tokens dt
     WHERE dt.user_id = $1
       AND ($2::text IS NULL OR NOT EXISTS (
         SELECT 1 FROM notification_prefs np WHERE np.user_id = dt.user_id AND $2 = ANY(np.disabled)))
       AND ($2::text IS NULL OR $3::uuid IS NULL OR NOT EXISTS (
         SELECT 1 FROM board_mutes m WHERE m.user_id = dt.user_id AND m.board_id = $3))`,
    [userId, kind, boardId]
  );
  return rows.map((r) => r.token);
}

/** Device tokens of a board's members (except the actor) who still want this
 *  kind of push and haven't muted the board. */
export async function boardRecipientTokens(
  boardId: string, actorId: string, kind: NotificationKind
): Promise<string[]> {
  const rows = await q<{ token: string }>(
    `SELECT dt.token FROM device_tokens dt
     JOIN board_members bm ON bm.user_id = dt.user_id
     WHERE bm.board_id = $1 AND dt.user_id <> $2
       AND NOT EXISTS (SELECT 1 FROM board_mutes m WHERE m.user_id = dt.user_id AND m.board_id = $1)
       AND NOT EXISTS (SELECT 1 FROM notification_prefs np WHERE np.user_id = dt.user_id AND $3 = ANY(np.disabled))`,
    [boardId, actorId, kind]
  );
  return rows.map((r) => r.token);
}

/** Send to tokens, pruning stale ones. True if any delivered. */
async function sendAll(tokens: string[], payload: object): Promise<boolean> {
  let delivered = false;
  await Promise.all(
    tokens.map(async (token) => {
      const status = await sendToToken(token, payload);
      if (status === 410 || status === 400) {
        await q("DELETE FROM device_tokens WHERE token = $1", [token]); // stale token
      } else if (status >= 200 && status < 300) {
        delivered = true;
      }
    })
  );
  return delivered;
}

/** Send a visible alert to every device a user has registered, unless they've
 *  switched this kind off (or muted the board it's about). Prunes stale
 *  tokens. Best-effort; never throws. */
export async function notifyUser(
  userId: string,
  title: string,
  body: string,
  extra: Record<string, string> = {},
  options: { timeSensitive?: boolean; kind?: NotificationKind } = {}
): Promise<boolean> {
  if (!pushEnabled) return false;
  try {
    const tokens = await userRecipientTokens(userId, options.kind ?? null, extra.board_id ?? null);
    if (tokens.length === 0) return false;
    return await sendAll(tokens, payloadFor(title, body, extra, userThread(extra), options));
  } catch (err) {
    console.error("[push] notifyUser failed:", (err as Error).message);
    return false;
  }
}

/** Notify every member of a board except the actor — skipping anyone who's
 *  muted the board or switched this kind off. Best-effort; never throws. */
export async function notifyBoard(
  boardId: string,
  actorId: string,
  title: string,
  body: string,
  extra: Record<string, string>,
  kind: NotificationKind
): Promise<void> {
  if (!pushEnabled) return;
  try {
    const tokens = await boardRecipientTokens(boardId, actorId, kind);
    if (tokens.length === 0) return;
    // One thread per board, so a board's notifications stack together.
    await sendAll(tokens, payloadFor(title, body, extra, `board-${boardId}`));
  } catch (err) {
    console.error("[push] notifyBoard failed:", (err as Error).message);
  }
}

/** Groups personal notifications by kind (shopping alerts, invites, digest…). */
export function userThread(extra: Record<string, string>): string {
  switch (extra.type) {
    case "price":
    case "restock":
      return "shopping";
    case "invite":
      return "invites";
    case "digest":
      return "digest";
    case "vote":
    case "reaction":
      return extra.board_id ? `board-${extra.board_id}` : "folio";
    default:
      return extra.board_id ? `board-${extra.board_id}` : "folio";
  }
}

/** Batches "@x added a save" pushes per board and person (see pushBatch.ts). */
export const saveBatcher = createSaveBatcher({
  notify: (boardId, actorId, title, body, extra) => notifyBoard(boardId, actorId, title, body, extra, "saves"),
});

/** Batches comment pushes per card and commenter. */
export const commentBatcher = createCommentBatcher({
  notify: (boardId, actorId, title, body, extra) => notifyBoard(boardId, actorId, title, body, extra, "comments"),
});

/** Batches "@x backed your save" pushes to the card's saver. */
export const voteBatcher = createVoteBatcher({
  notify: (userId, title, body, extra) => notifyUser(userId, title, body, extra, { kind: "decisions" }),
});

/** Batches "@x ❤️ your save" pushes to the card's saver. */
export const reactionBatcher = createReactionBatcher({
  notify: (userId, title, body, extra) => notifyUser(userId, title, body, extra, { kind: "reactions" }),
});
