// Fetch a brand's logo once (server-side, from Fly's IP — never the user's
// device), re-host it on our public bucket, and cache the URL by domain. So the
// app only ever loads logos from our own CDN, and each brand is fetched once
// globally. Best-effort: returns null and the card falls back to its kind tile.

import { one, q } from "../db.js";
import { putObject, storageEnabled } from "../storage.js";

// No single provider is reliably hi-res per brand (BA is only 180px on Google
// but 32px elsewhere; easyJet is 256px only on icon.horse). So we try several,
// measure the actual pixel size, and keep the largest. Clearbit's free API was
// retired, so it's dropped.
const SOURCES = (domain: string) => [
  `https://icon.horse/icon/${domain}`,
  `https://www.google.com/s2/favicons?domain=${domain}&sz=256`,
  `https://icons.duckduckgo.com/ip3/${domain}.ico`,
];

const MIN_OK = 64;   // below this a logo looks blurry — prefer the crisp kind tile
const GREAT = 176;   // stop early once we find something this sharp

/** Width/height from a PNG or JPEG header — no image dependency. */
export function imageSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) { // PNG IHDR
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {   // JPEG SOF
    let o = 2;
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const marker = buf[o + 1]!;
      if (marker >= 0xc0 && marker <= 0xc3) return { h: buf.readUInt16BE(o + 5), w: buf.readUInt16BE(o + 7) };
      o += 2 + buf.readUInt16BE(o + 2);
    }
  }
  return null;
}

export async function resolveBrandLogo(domain: string): Promise<string | null> {
  if (!storageEnabled || !domain) return null;

  const cached = await one<{ url: string }>("SELECT url FROM brand_logos WHERE domain = $1", [domain]).catch(() => null);
  if (cached) return cached.url || null; // '' marks a prior miss — don't refetch

  let best: { buf: Buffer; type: string; ext: string; min: number } | null = null;
  for (const src of SOURCES(domain)) {
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) continue;
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      if (!/image\/(png|jpe?g)/.test(type)) continue; // iOS can't render .ico/.svg
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100 || buf.length > 2_000_000) continue;
      const size = imageSize(buf);
      const min = size ? Math.min(size.w, size.h) : 0;
      if (min < MIN_OK) continue; // too small → would look blurry
      if (!best || min > best.min) best = { buf, type, ext: type.includes("png") ? "png" : "jpg", min };
      if (best.min >= GREAT) break; // sharp enough, stop early
    } catch { /* try next source */ }
  }

  if (best) {
    const url = await putObject(`logos/v2/${domain}.${best.ext}`, best.buf, best.type);
    await q(
      `INSERT INTO brand_logos (domain, url) VALUES ($1,$2)
       ON CONFLICT (domain) DO UPDATE SET url = EXCLUDED.url, fetched_at = now()`,
      [domain, url]
    ).catch(() => {});
    return url;
  }
  // Cache the miss so we don't hammer the logo services on every email.
  await q("INSERT INTO brand_logos (domain, url) VALUES ($1,'') ON CONFLICT (domain) DO NOTHING", [domain]).catch(() => {});
  return null;
}
