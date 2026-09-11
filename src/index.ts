import { buildApp } from "./app.js";
import { config } from "./config.js";
import { startExtractionWorker } from "./extraction.js";
import { startDigestWorker } from "./digest.js";
import { applySchema } from "./db.js";

const app = buildApp();

// Self-migrate on boot (idempotent) so hosted deploys need no separate step.
try {
  await applySchema();
  app.log.info("schema applied");
} catch (err) {
  app.log.error({ err: String(err) }, "schema apply failed");
}

const worker = startExtractionWorker();
const digestWorker = startDigestWorker();

const shutdown = async () => {
  clearInterval(worker);
  clearInterval(digestWorker);
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Backstop: never let a stray rejection/exception (e.g. a transient network or
// DB blip in a background extraction) take the whole API down.
process.on("unhandledRejection", (reason) => {
  app.log.error({ reason: String(reason) }, "unhandledRejection (ignored)");
});
process.on("uncaughtException", (err) => {
  app.log.error({ err: String(err) }, "uncaughtException (ignored)");
});

app
  .listen({ port: config.PORT, host: "0.0.0.0" })
  .then((addr) => app.log.info(`Folio backend listening on ${addr}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
