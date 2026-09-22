import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { one } from "../db.js";
import { config } from "../config.js";

// A tiny founder dashboard: totals, growth, and activity. Guarded by HTTP Basic
// auth (any username; password = ADMIN_KEY, a Fly secret) so the key never sits
// in the URL / browser history / access logs. Disabled entirely (404) if
// ADMIN_KEY isn't set.
export async function adminRoutes(app: FastifyInstance) {
  // Constant-time password check against ADMIN_KEY. Returns true if authorized;
  // otherwise writes the appropriate response (404 when disabled, 401 + a Basic
  // challenge so the browser prompts) and returns false.
  function authorized(req: FastifyRequest, reply: FastifyReply): boolean {
    if (!config.ADMIN_KEY) {
      reply.code(404).type("text/plain").send("not found");
      return false;
    }
    const hdr = req.headers.authorization ?? "";
    let pass = "";
    if (hdr.startsWith("Basic ")) {
      const decoded = Buffer.from(hdr.slice(6), "base64").toString("utf8");
      pass = decoded.slice(decoded.indexOf(":") + 1); // ignore username
    }
    const a = Buffer.from(pass);
    const b = Buffer.from(config.ADMIN_KEY);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (!ok) {
      reply
        .code(401)
        .header("WWW-Authenticate", 'Basic realm="Folio", charset="UTF-8"')
        .type("text/plain")
        .send("unauthorized");
      return false;
    }
    return true;
  }

  async function metrics() {
    const row = await one<any>(`
      SELECT
        (SELECT count(*) FROM users)                                             AS users,
        (SELECT count(*) FROM users WHERE created_at > now() - interval '7 days')  AS users_7d,
        (SELECT count(*) FROM users WHERE created_at > now() - interval '1 day')   AS users_24h,
        (SELECT count(*) FROM boards)                                            AS boards,
        (SELECT count(*) FROM boards WHERE kind = 'shared')                      AS boards_shared,
        (SELECT count(*) FROM cards)                                             AS cards,
        (SELECT count(*) FROM cards WHERE created_at > now() - interval '7 days')  AS cards_7d,
        (SELECT count(*) FROM cards WHERE created_at > now() - interval '1 day')   AS cards_24h,
        (SELECT count(DISTINCT added_by) FROM cards WHERE created_at > now() - interval '7 days') AS active_7d,
        (SELECT count(DISTINCT added_by) FROM cards WHERE created_at > now() - interval '1 day')  AS active_24h,
        (SELECT count(*) FROM card_votes)                                        AS votes,
        (SELECT count(*) FROM mcp_tokens)                                        AS mcp_tokens
    `);
    const { q } = await import("../db.js");
    const types = await q<any>(
      `SELECT type, count(*)::int AS n FROM cards GROUP BY type ORDER BY n DESC`
    );
    const users = await q<any>(`
      SELECT u.id, u.handle, u.display_name, u.email, u.created_at,
             (u.apple_sub LIKE 'dev:%') AS is_dev,
             (SELECT count(*) FROM cards  c WHERE c.added_by = u.id)::int AS saves,
             (SELECT count(*) FROM boards b WHERE b.owner_id = u.id)::int AS boards,
             (SELECT max(c.created_at) FROM cards c WHERE c.added_by = u.id) AS last_active
      FROM users u
      ORDER BY u.created_at DESC
    `);
    return { row, types, users };
  }

  app.get("/admin", async (req, reply) => {
    if (!authorized(req, reply)) return reply;

    const { row, types, users } = await metrics();
    const n = (v: any) => Number(v ?? 0).toLocaleString("en-GB");
    const esc = (s: any) =>
      String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
    const date = (v: any) => (v ? new Date(v).toISOString().slice(0, 10) : "—");
    const card = (label: string, value: any, sub = "") =>
      `<div class="c"><div class="v">${n(value)}</div><div class="l">${label}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`;
    const typeRows = types
      .map((t) => `<tr><td>${esc(t.type)}</td><td style="text-align:right">${n(t.n)}</td></tr>`)
      .join("");
    const userRows = users
      .map((u) => {
        const who = esc(u.handle ? "@" + u.handle : u.display_name || "—");
        const dev = u.is_dev ? ' <span class="tag">dev</span>' : "";
        return `<tr>
          <td>${who}${dev}</td>
          <td>${u.email ? esc(u.email) : '<span class="muted">—</span>'}</td>
          <td>${date(u.created_at)}</td>
          <td style="text-align:right">${n(u.saves)}</td>
          <td style="text-align:right">${n(u.boards)}</td>
          <td>${date(u.last_active)}</td>
        </tr>`;
      })
      .join("");

    reply.type("text/html");
    return `<!doctype html><html><head><meta charset="utf8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Folio · metrics</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px -apple-system,system-ui,sans-serif; margin: 0; padding: 28px; background: #faf7f8; color: #1c1c1e; }
  @media (prefers-color-scheme: dark){ body{ background:#111; color:#eee } .c,.t{ background:#1c1c1e!important } }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8a8a8e; margin: 0 0 24px; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(150px,1fr)); gap: 12px; }
  .c { background: #fff; border-radius: 14px; padding: 16px; }
  .v { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
  .l { color: #8a8a8e; font-size: 13px; margin-top: 2px; }
  .s { color: #34c759; font-size: 12px; margin-top: 4px; }
  .t { background:#fff; border-radius:14px; padding:8px 16px; margin-top:20px; max-width:340px; }
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: 8px 10px; border-bottom: 1px solid rgba(128,128,128,.15); text-align: left; }
  .t tr:last-child td { border: 0; }
  h2 { font-size: 15px; margin: 28px 0 8px; }
  .users { background:#fff; border-radius:14px; padding:4px 16px; overflow-x:auto; }
  @media (prefers-color-scheme: dark){ .users{ background:#1c1c1e } }
  th { color:#8a8a8e; font-weight:600; font-size:12px; }
  .muted { color:#c7c7cc; }
  .tag { font-size:10px; background:rgba(128,128,128,.18); border-radius:5px; padding:1px 5px; vertical-align:middle; }
</style></head><body>
  <h1>Folio</h1>
  <p class="sub">Live metrics · ${new Date().toUTCString()}</p>
  <div class="grid">
    ${card("Users", row.users, `+${n(row.users_24h)} today · +${n(row.users_7d)} this week`)}
    ${card("Active (7d)", row.active_7d, `${n(row.active_24h)} today`)}
    ${card("Saves", row.cards, `+${n(row.cards_24h)} today · +${n(row.cards_7d)} this week`)}
    ${card("Boards", row.boards, `${n(row.boards_shared)} shared`)}
    ${card("Votes cast", row.votes)}
    ${card("AI tokens", row.mcp_tokens)}
  </div>
  <div class="t"><table><tr><td><b>Saves by type</b></td><td></td></tr>${typeRows}</table></div>
  <h2>Users · ${n(row.users)}</h2>
  <div class="users"><table>
    <tr><th>User</th><th>Email</th><th>Joined</th><th style="text-align:right">Saves</th><th style="text-align:right">Boards</th><th>Last active</th></tr>
    ${userRows}
  </table></div>
</body></html>`;
  });
}
