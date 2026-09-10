import { z } from "zod";

// Load .env into process.env (Node ≥ 20.12 built-in; no dotenv dependency).
try { process.loadEnvFile(); } catch { /* no .env file — use defaults/real env */ }

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default("postgres://folio:folio@localhost:5433/folio"),
  SESSION_JWT_SECRET: z.string().default("dev-secret-change-me"),
  AUTH_DEV_BYPASS: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  APPLE_CLIENT_ID: z.string().default("com.thedoidea.co.Folio"),
  PUBLIC_BASE_URL: z.string().default("http://localhost:3000"),
  EXTRACTION_MODE: z.enum(["stub", "live"]).default("stub"),
});

export const config = schema.parse(process.env);
export type Config = typeof config;
