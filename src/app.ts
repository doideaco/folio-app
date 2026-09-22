import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { AppError } from "./errors.js";
import { authRoutes } from "./routes/auth.js";
import { boardsRoutes } from "./routes/boards.js";
import { savesRoutes } from "./routes/saves.js";
import { cardsRoutes } from "./routes/cards.js";
import { syncRoutes } from "./routes/sync.js";
import { uploadsRoutes } from "./routes/uploads.js";
import { previewRoutes } from "./routes/preview.js";
import { linksRoutes } from "./routes/links.js";
import { devicesRoutes } from "./routes/devices.js";
import { inboundRoutes } from "./routes/inbound.js";
import { mcpRoutes } from "./routes/mcp.js";
import { adminRoutes } from "./routes/admin.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({
    // Privacy: log method + url only, never bodies.
    logger: { level: "info", serializers: { req: (r) => ({ method: r.method, url: r.url }) } },
    // Forwarded emails carry base64 attachments (tickets/PDFs) + HTML bodies.
    bodyLimit: 20 * 1024 * 1024,
  });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: error.message, code: error.code });
    }
    if (error instanceof ZodError) {
      return reply.code(422).send({ error: "validation_failed", details: error.issues });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "internal_error" });
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.register(authRoutes);
  app.register(boardsRoutes);
  app.register(savesRoutes);
  app.register(cardsRoutes);
  app.register(syncRoutes);
  app.register(uploadsRoutes);
  app.register(previewRoutes);
  app.register(linksRoutes);
  app.register(devicesRoutes);
  app.register(inboundRoutes);
  app.register(mcpRoutes);
  app.register(adminRoutes);

  return app;
}
