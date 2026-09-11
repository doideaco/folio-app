import type { FastifyInstance } from "fastify";

// Team ID + bundle id form the Universal Links appID.
const APP_ID = "6248KDJL92.com.thedoidea.co.Folio";

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
    reply.type("text/html");
    return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Folio invite</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:28rem;margin:20vh auto;padding:0 1.5rem;text-align:center;color:#111}
h1{font-size:1.5rem}p{color:#555;line-height:1.5}</style></head>
<body><h1>You've been invited to a Folio board</h1>
<p>Open this link on the device where Folio is installed to join. If you don't have Folio yet, it'll be available on the App Store soon.</p>
</body></html>`;
  });
}
