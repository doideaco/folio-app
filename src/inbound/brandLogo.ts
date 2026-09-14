// Fetch a brand's logo once (server-side, from Fly's IP — never the user's
// device), re-host it on our public bucket, and cache the URL by domain. So the
// app only ever loads logos from our own CDN, and each brand is fetched once
// globally. Best-effort: returns null and the card falls back to its kind tile.

import { one, q } from "../db.js";
import { putObject, storageEnabled } from "../storage.js";

const SOURCES = (domain: string) => [
  `https://logo.clearbit.com/${domain}?size=256&format=png`,
  `https://icons.duckduckgo.com/ip3/${domain}.ico`,
];

export async function resolveBrandLogo(domain: string): Promise<string | null> {
  if (!storageEnabled || !domain) return null;

  const cached = await one<{ url: string }>("SELECT url FROM brand_logos WHERE domain = $1", [domain]).catch(() => null);
  if (cached) return cached.url || null; // '' marks a prior miss — don't refetch

  for (const src of SOURCES(domain)) {
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) continue;
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      if (!type.startsWith("image/")) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100 || buf.length > 2_000_000) continue;
      const ext = type.includes("png") ? "png" : type.includes("jpeg") ? "jpg"
        : type.includes("svg") ? "svg" : (type.includes("icon") || type.includes("ico")) ? "ico" : "png";
      const url = await putObject(`logos/${domain}.${ext}`, buf, type);
      await q(
        `INSERT INTO brand_logos (domain, url) VALUES ($1,$2)
         ON CONFLICT (domain) DO UPDATE SET url = EXCLUDED.url, fetched_at = now()`,
        [domain, url]
      ).catch(() => {});
      return url;
    } catch { /* try next source */ }
  }
  // Cache the miss so we don't hammer the logo services on every email.
  await q("INSERT INTO brand_logos (domain, url) VALUES ($1,'') ON CONFLICT (domain) DO NOTHING", [domain]).catch(() => {});
  return null;
}
