import http2 from "node:http2";
import { SignJWT, importPKCS8 } from "jose";
import { config } from "./config.js";
import { q } from "./db.js";

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

/** Push to all of one user's devices. Returns true if at least one delivered.
 *  Prunes stale tokens. Best-effort; never throws. */
export async function notifyUser(
  userId: string,
  title: string,
  body: string,
  extra: Record<string, string> = {}
): Promise<boolean> {
  if (!pushEnabled) return false;
  try {
    const rows = await q<{ token: string }>(
      "SELECT token FROM device_tokens WHERE user_id = $1",
      [userId]
    );
    if (rows.length === 0) return false;
    const payload = { aps: { alert: { title, body }, sound: "default" }, ...extra };
    let delivered = false;
    await Promise.all(
      rows.map(async ({ token }) => {
        const status = await sendToToken(token, payload);
        if (status === 410 || status === 400) {
          await q("DELETE FROM device_tokens WHERE token = $1", [token]); // stale token
        } else if (status >= 200 && status < 300) {
          delivered = true;
        }
      })
    );
    return delivered;
  } catch (err) {
    console.error("[push] notifyUser failed:", (err as Error).message);
    return false;
  }
}

/** Notify every member of a board except the actor. Best-effort; never throws. */
export async function notifyBoard(
  boardId: string,
  actorId: string,
  title: string,
  body: string,
  extra: Record<string, string> = {}
): Promise<void> {
  if (!pushEnabled) return;
  try {
    const rows = await q<{ token: string }>(
      `SELECT dt.token FROM device_tokens dt
       JOIN board_members bm ON bm.user_id = dt.user_id
       WHERE bm.board_id = $1 AND dt.user_id <> $2`,
      [boardId, actorId]
    );
    if (rows.length === 0) return;
    const payload = { aps: { alert: { title, body }, sound: "default" }, ...extra };
    await Promise.all(
      rows.map(async ({ token }) => {
        const status = await sendToToken(token, payload);
        if (status === 410 || status === 400) {
          await q("DELETE FROM device_tokens WHERE token = $1", [token]); // stale token
        }
      })
    );
  } catch (err) {
    console.error("[push] notifyBoard failed:", (err as Error).message);
  }
}
