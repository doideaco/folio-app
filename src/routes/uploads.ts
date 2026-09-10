import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { requireUserId } from "../auth.js";
import { badRequest } from "../errors.js";
import { putObject, storageEnabled } from "../storage.js";

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB — screenshots are downsampled client-side.

export async function uploadsRoutes(app: FastifyInstance) {
  // Accept raw JPEG/PNG bodies (the client downsamples before sending).
  app.addContentTypeParser(
    ["image/jpeg", "image/png"],
    { parseAs: "buffer", bodyLimit: MAX_BYTES },
    (_req, body, done) => done(null, body)
  );

  // POST /uploads — store an image and return its public URL.
  app.post("/uploads", async (req) => {
    await requireUserId(req);
    if (!storageEnabled) throw badRequest("object storage not configured");
    const body = req.body as Buffer | undefined;
    if (!body || !Buffer.isBuffer(body) || body.length === 0) {
      throw badRequest("empty image body");
    }
    const contentType = req.headers["content-type"] === "image/png" ? "image/png" : "image/jpeg";
    const ext = contentType === "image/png" ? "png" : "jpg";
    const url = await putObject(`cards/${randomUUID()}.${ext}`, body, contentType);
    return { url };
  });
}
