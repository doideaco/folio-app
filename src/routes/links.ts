import type { FastifyInstance } from "fastify";
import { q, one } from "../db.js";
import { config } from "../config.js";

// Team ID + bundle id form the Universal Links appID.
const APP_ID = "6248KDJL92.com.thedoidea.co.Folio";

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );

export async function linksRoutes(app: FastifyInstance) {
  // Apple App Site Association — lets iOS open invite links directly in the app.
  // Must be served at this exact path, as application/json, with no redirect.
  app.get("/.well-known/apple-app-site-association", async (_req, reply) => {
    reply.type("application/json");
    return {
      applinks: {
        apps: [],
        details: [{ appID: APP_ID, paths: ["/invite/*"] }],
      },
    };
  });

  // Human landing page for an invite link — only seen if the app isn't installed
  // (otherwise iOS intercepts the URL and opens Folio).
  app.get("/invite/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    reply.type("text/html");

    // Resolve the invite → board + inviter so the link unfurls richly (Messages,
    // WhatsApp, Slack…) and the page greets the invitee by board.
    const invite = await one<any>(
      "SELECT board_id, created_by FROM board_invites WHERE token = $1", [token]
    );
    const board = invite ? await one<any>("SELECT * FROM boards WHERE id = $1", [invite.board_id]) : null;
    const inviter = invite ? await one<any>("SELECT handle FROM users WHERE id = $1", [invite.created_by]) : null;

    const who = inviter?.handle ? `@${inviter.handle}` : "Someone";
    const title = board ? `${board.emoji ? board.emoji + " " : ""}${board.name}` : "A Folio board";
    const heading = board ? `${who} invited you to “${board.name}”` : "You've been invited to a Folio board";

    let cover: string | null = null;
    let count = 0;
    if (board) {
      const c = await one<any>(
        `SELECT thumb_url FROM cards
         WHERE board_id = $1 AND thumb_url IS NOT NULL AND status = 'ready'
         ORDER BY (id = $2) DESC, created_at DESC LIMIT 1`,
        [board.id, board.cover_card_id]
      );
      cover = c?.thumb_url ?? null;
      count = (await one<any>(
        "SELECT count(*)::int AS n FROM cards WHERE board_id = $1 AND status = 'ready'", [board.id]
      ))?.n ?? 0;
    }
    const desc = board
      ? `${who} shared this board on Folio${count ? ` · ${count} save${count === 1 ? "" : "s"}` : ""}. Tap to join.`
      : "Open this link on a device with Folio to join.";

    const og = [
      `<meta property="og:title" content="${esc(title)}">`,
      `<meta property="og:description" content="${esc(desc)}">`,
      `<meta property="og:type" content="website">`,
      cover ? `<meta property="og:image" content="${esc(cover)}">` : "",
      `<meta name="twitter:card" content="${cover ? "summary_large_image" : "summary"}">`,
    ].join("\n");

    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Folio</title>
${og}
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:28rem;margin:16vh auto;padding:0 1.5rem;text-align:center;color:#111}
@media(prefers-color-scheme:dark){body{color:#eee;background:#111}}
h1{font-size:1.5rem;line-height:1.3}p{color:#888;line-height:1.5}
.cover{width:120px;height:120px;border-radius:20px;object-fit:cover;margin:0 auto 1.25rem;display:block;box-shadow:0 4px 16px rgba(0,0,0,.15)}
.cta{display:inline-block;margin:1.25rem 0 .5rem;padding:.85rem 1.5rem;background:#0a84ff;color:#fff;font-weight:600;border-radius:14px;text-decoration:none}
.hint{font-size:.85rem}</style></head>
<body>
${cover ? `<img class="cover" src="${esc(cover)}" alt="">` : ""}
<h1>${esc(heading)}</h1>
${config.APP_STORE_URL
  ? `<a class="cta" href="${esc(config.APP_STORE_URL)}">Get Folio — free</a>
<p class="hint">Install Folio, then tap this link again to join${board ? ` “${esc(board.name)}”` : ""}. Already have it? Just tap the link again.</p>`
  : `<p>Open this link on the device where Folio is installed to join${board ? ` and start adding to “${esc(board.name)}”` : ""}. Don't have Folio yet? It'll be on the App Store soon.</p>`}
</body></html>`;
  });

  // Public read-only board page (opt-in via /boards/:id/publish). Unguessable slug.
  app.get("/b/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    reply.type("text/html");
    const board = await one<any>("SELECT * FROM boards WHERE public_slug = $1", [slug]);
    if (!board) {
      reply.code(404);
      return `<!doctype html><meta charset="utf-8"><title>Not found</title>
<body style="font-family:-apple-system,system-ui,sans-serif;text-align:center;margin:20vh 1.5rem;color:#555">
<h1 style="color:#111">Board not found</h1><p>This page may have been unpublished.</p></body>`;
    }
    const cards = await q<any>(
      `SELECT title, thumb_url, type, source_url, caption FROM cards
       WHERE board_id = $1 AND status = 'ready' ORDER BY created_at DESC LIMIT 300`,
      [board.id]
    );
    const title = `${board.emoji ? board.emoji + " " : ""}${board.name}`;
    const tiles = cards.map((c) => {
      const href = c.source_url ? ` href="${esc(c.source_url)}" target="_blank" rel="noopener"` : "";
      const tag = href ? "a" : "div";
      const img = c.thumb_url
        ? `<div class="thumb" style="background-image:url('${esc(c.thumb_url)}')"></div>`
        : `<div class="thumb ph"></div>`;
      const sub = c.caption ? `<p class="sub">${esc(String(c.caption).slice(0, 100))}</p>` : "";
      return `<${tag} class="card"${href}>${img}<div class="body"><p class="t">${esc(c.title ?? c.type)}</p>${sub}</div></${tag}>`;
    }).join("");

    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Folio</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${cards.length} saves on Folio">
<meta property="og:type" content="website">
${cards.find((c) => c.thumb_url) ? `<meta property="og:image" content="${esc(cards.find((c) => c.thumb_url)!.thumb_url)}">
<meta name="twitter:card" content="summary_large_image">` : ""}
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font-family:-apple-system,system-ui,sans-serif;margin:0;color:#111;background:#fafafa}
@media(prefers-color-scheme:dark){body{color:#eee;background:#111}.card{background:#1c1c1e!important}}
header{padding:2.5rem 1.5rem 1rem;max-width:60rem;margin:0 auto}
h1{font-size:1.8rem;margin:0}
.meta{color:#888;margin:.25rem 0 0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:1rem;padding:1rem 1.5rem 3rem;max-width:60rem;margin:0 auto}
.card{background:#fff;border-radius:14px;overflow:hidden;text-decoration:none;color:inherit;box-shadow:0 1px 3px rgba(0,0,0,.08);display:flex;flex-direction:column}
.thumb{aspect-ratio:1;background-size:cover;background-position:center;background-color:#e5e5ea}
.thumb.ph{background:linear-gradient(135deg,#d1d1d6,#e5e5ea)}
.body{padding:.6rem .7rem}
.t{font-weight:600;font-size:.9rem;margin:0;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sub{color:#888;font-size:.75rem;margin:.25rem 0 0;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
footer{text-align:center;color:#aaa;font-size:.8rem;padding:0 0 3rem}
</style></head><body>
<header><h1>${esc(title)}</h1><p class="meta">${cards.length} ${cards.length === 1 ? "save" : "saves"} · shared from Folio</p></header>
<div class="grid">${tiles || "<p style='color:#888'>No saves yet.</p>"}</div>
<footer>${config.APP_STORE_URL
  ? `<a href="${esc(config.APP_STORE_URL)}" style="color:#0a84ff;font-weight:600;text-decoration:none">Save your own with Folio →</a>`
  : "Made with Folio"}</footer>
</body></html>`;
  });
}
