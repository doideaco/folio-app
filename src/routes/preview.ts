import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "../errors.js";
import { previewMetadata } from "../extraction.js";

// Blocks localhost / private ranges to keep this open endpoint from being used
// as an SSRF proxy into internal networks.
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "[::1]" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^(127\.|10\.|169\.254\.|0\.)/.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

export async function previewRoutes(app: FastifyInstance) {
  // GET /preview?url= — public (rate-limited by Fly) metadata preview for the
  // share sheet. Reuses the extraction pipeline; returns {title, image, author}.
  app.get("/preview", async (req) => {
    const { url } = z.object({ url: z.string().url() }).parse(req.query ?? {});
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw badRequest("bad url"); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw badRequest("unsupported scheme");
    if (isBlockedHost(parsed.hostname)) throw badRequest("blocked host");
    return previewMetadata(url);
  });
}
