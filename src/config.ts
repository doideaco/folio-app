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
  // APNs (token auth). Push is disabled unless the key trio is set.
  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_KEY: z.string().optional(), // .p8 private key contents (PEM)
  APNS_BUNDLE_ID: z.string().default("com.thedoidea.co.Folio"),
  APNS_ENV: z.enum(["sandbox", "production"]).default("production"),
  // Email-to-Folio: the domain forwarding addresses live on, and a shared
  // secret the Cloudflare email Worker presents. Inbound is disabled until set.
  INBOUND_DOMAIN: z.string().default("folioinbox.me"),
  INBOUND_SECRET: z.string().optional(),
  // Password for the /admin metrics dashboard. Disabled unless set.
  ADMIN_KEY: z.string().optional(),
  // App Store product URL. When set, invite / public pages show a Download
  // button (the "shared with someone who doesn't have Folio" install funnel).
  APP_STORE_URL: z.string().optional(),
});

export const config = schema.parse(process.env);
export type Config = typeof config;
