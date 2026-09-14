// Fetch a brand's logo once (server-side, from Fly's IP — never the user's
// device), re-host it on our public bucket, and cache the URL by domain. So the
// app only ever loads logos from our own CDN, and each brand is fetched once
// globally. Best-effort: returns null and the card falls back to its kind tile.

import { one, q } from "../db.js";
import { putObject, storageEnabled } from "../storage.js";

// DuckDuckGo first (often the real, higher-res logo), then Google favicons (always
// PNG, reliable fallback). Clearbit's free API was retired, so it's dropped.
const SOURCES = (domain: string) => [
  `https://icons.duckduckgo.com/ip3/${domain}.ico`,
  `https://www.google.com/s2/favicons?domain=${domain}&sz=256`,
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
      // Only PNG/JPEG — iOS UIImage won't render .ico or .svg (a DDG .ico result
      // falls through to Google's PNG).
      if (!/image\/(png|jpe?g)/.test(type)) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100 || buf.length > 2_000_000) continue;
      const ext = type.includes("png") ? "png" : "jpg";
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
