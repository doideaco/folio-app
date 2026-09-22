import type { FastifyInstance } from "fastify";
import { one } from "../db.js";
import { config } from "../config.js";

// A tiny founder dashboard: totals, growth, and activity. Password-gated with
// ?key=ADMIN_KEY (a Fly secret). Disabled entirely if ADMIN_KEY isn't set.
export async function adminRoutes(app: FastifyInstance) {
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
    const types = await import("../db.js").then((m) =>
      m.q<any>(`SELECT type, count(*)::int AS n FROM cards GROUP BY type ORDER BY n DESC`)
    );
    return { row, types };
  }

  app.get("/admin", async (req, reply) => {
    const key = (req.query as { key?: string }).key;
    if (!config.ADMIN_KEY || key !== config.ADMIN_KEY) {
      reply.code(config.ADMIN_KEY ? 401 : 404);
      return reply.type("text/plain").send(config.ADMIN_KEY ? "unauthorized" : "not found");
    }

    const { row, types } = await metrics();
    const n = (v: any) => Number(v ?? 0).toLocaleString("en-GB");
    const card = (label: string, value: any, sub = "") =>
      `<div class="c"><div class="v">${n(value)}</div><div class="l">${label}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`;
    const typeRows = types
      .map((t) => `<tr><td>${t.type}</td><td style="text-align:right">${n(t.n)}</td></tr>`)
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
  td { padding: 8px 0; border-bottom: 1px solid rgba(128,128,128,.15); }
  tr:last-child td { border: 0; }
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
</body></html>`;
  });
}
