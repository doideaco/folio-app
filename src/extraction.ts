// Extraction pipeline. In stub mode it drives the real pending -> processing ->
// ready state machine with deterministic, secret-free extractors, committing
// partial progress between stages so /sync shows the card advancing.

import { q, one } from "./db.js";
import { config } from "./config.js";
import { cacheRemoteImage } from "./storage.js";

const inFlight = new Set<string>();
const STAGE_DELAY_MS = 1200;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Exponential backoff for transient extraction failures: 1m, 10m, 1h, 6h.
const RETRY_DELAYS = [60, 600, 3600, 21600];

async function scheduleRetryOrFail(cardId: string, reason: string): Promise<void> {
  const st = await one<{ attempts: number }>(
    "SELECT attempts FROM card_extraction_state WHERE card_id = $1",
    [cardId]
  );
  const attempts = (st?.attempts ?? 0) + 1;
  if (attempts <= RETRY_DELAYS.length) {
    const delaySec = RETRY_DELAYS[attempts - 1]!;
    await q(
      `INSERT INTO card_extraction_state (card_id, attempts, last_error, next_retry_at)
       VALUES ($1,$2,$3, now() + ($4 || ' seconds')::interval)
       ON CONFLICT (card_id) DO UPDATE
         SET attempts = EXCLUDED.attempts, last_error = EXCLUDED.last_error, next_retry_at = EXCLUDED.next_retry_at`,
      [cardId, attempts, reason.slice(0, 300), String(delaySec)]
    );
    // Keep it retriable; the worker picks it up again after next_retry_at.
    await q(`UPDATE cards SET status='pending', updated_at=now() WHERE id = $1`, [cardId]);
  } else {
    await q(`UPDATE cards SET status='failed', updated_at=now() WHERE id = $1`, [cardId]);
  }
}

// --- Generic OpenGraph metadata fetch (live mode) --------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function metaContent(html: string, key: string): string | undefined {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${key}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeEntities(m[1]);
  }
  return undefined;
}

interface PageMeta {
  finalUrl: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  price?: string;   // e.g. "£24.00" — from JSON-LD product offers
  brand?: string;   // e.g. "Buster + Punch"
}

// A realistic desktop Safari UA. Non-hostile sites serve full OpenGraph to this;
// hostile ones (Etsy/Amazon/IG) block by IP regardless, so on-device fetch is
// the real answer for those.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

/** Resolve a possibly-relative URL against the page it came from. */
function absolutize(u: string | undefined, base: string): string | undefined {
  if (!u) return undefined;
  try { return new URL(u, base).toString(); } catch { return undefined; }
}

function firstMatch(html: string, re: RegExp): string | undefined {
  const m = html.match(re);
  return m?.[1] ? decodeEntities(m[1]) : undefined;
}

function formatPrice(amount: string, currency?: string): string {
  const symbols: Record<string, string> = { GBP: "£", USD: "$", EUR: "€", JPY: "¥" };
  const sym = currency ? symbols[currency] ?? `${currency} ` : "";
  return `${sym}${amount}`;
}

/** Pull structured data from schema.org JSON-LD blocks — the richest signal for
 *  products (name/image/price/brand), recipes, and articles. Best-effort. */
function parseJsonLd(html: string, base: string): Partial<PageMeta> {
  const out: Partial<PageMeta> = {};
  const blocks = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const b of blocks) {
    let data: any;
    try { data = JSON.parse((b[1] ?? "").trim()); } catch { continue; }
    const nodes: any[] = Array.isArray(data) ? data : data?.["@graph"] ? data["@graph"] : [data];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      if (!out.title && typeof node.name === "string") out.title = node.name.trim();
      if (!out.description && typeof node.description === "string") out.description = node.description.trim();
      if (!out.image) {
        const img = node.image;
        const url =
          typeof img === "string" ? img
          : Array.isArray(img) ? (typeof img[0] === "string" ? img[0] : img[0]?.url)
          : img?.url;
        if (typeof url === "string") out.image = absolutize(url, base);
      }
      if (!out.brand && node.brand) {
        out.brand = typeof node.brand === "string" ? node.brand : node.brand?.name;
      }
      if (!out.price && node.offers) {
        const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
        const amount = offer?.price ?? offer?.lowPrice;
        if (amount != null) out.price = formatPrice(String(amount), offer?.priceCurrency);
      }
    }
  }
  return out;
}

/** Combine every metadata signal on a page into one PageMeta: OpenGraph first,
 *  then Twitter cards, then JSON-LD, then the <title>/description/favicon. */
function extractPageMeta(html: string, finalUrl: string): PageMeta {
  const jsonld = parseJsonLd(html, finalUrl);
  const titleTag = firstMatch(html, /<title[^>]*>([^<]*)<\/title>/i)?.trim();
  const icon =
    firstMatch(html, /<link[^>]+rel=["'](?:apple-touch-icon|icon|shortcut icon)["'][^>]+href=["']([^"']+)["']/i) ??
    firstMatch(html, /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:apple-touch-icon|icon|shortcut icon)["']/i);

  let host = "";
  try { host = new URL(finalUrl).host.replace(/^www\./, ""); } catch { /* keep "" */ }

  const image =
    absolutize(metaContent(html, "og:image"), finalUrl) ??
    absolutize(metaContent(html, "twitter:image") ?? metaContent(html, "twitter:image:src"), finalUrl) ??
    jsonld.image ??
    absolutize(icon, finalUrl);

  return {
    finalUrl,
    title:
      metaContent(html, "og:title") ??
      metaContent(html, "twitter:title") ??
      jsonld.title ??
      titleTag ??
      (host || undefined),
    description:
      metaContent(html, "og:description") ??
      metaContent(html, "twitter:description") ??
      jsonld.description ??
      metaContent(html, "description"),
    image,
    siteName: metaContent(html, "og:site_name") ?? (host || undefined),
    price: jsonld.price,
    brand: jsonld.brand,
  };
}

// Free public oEmbed endpoints (no key) — reliable title + thumbnail for
// YouTube and TikTok, which don't expose useful OpenGraph to scrapers.
function oembedEndpoint(url: string): string | null {
  let host = "";
  try { host = new URL(url).host.toLowerCase(); } catch { return null; }
  if (host.includes("youtube") || host.includes("youtu.be")) {
    return `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  }
  if (host.includes("tiktok")) {
    return `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  }
  return null;
}

async function fetchOEmbed(url: string): Promise<PageMeta | null> {
  const endpoint = oembedEndpoint(url);
  if (!endpoint) return null;
  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    return {
      finalUrl: url,
      title: j.title ?? undefined,
      description: j.author_name ? `by ${j.author_name}` : undefined,
      image: j.thumbnail_url ?? undefined,
      siteName: j.author_name ?? undefined,
    };
  } catch {
    return null;
  }
}

// Instagram walls the normal page but its /embed/captioned/ page is public and
// contains the poster-frame image + caption + author — no token needed.
function jsonUnescape(s: string): string {
  try { return JSON.parse('"' + s + '"'); } catch { return s.replace(/\\\//g, "/"); }
}

async function fetchInstagramEmbed(url: string): Promise<PageMeta | null> {
  const embed = url.replace(/\/+$/, "") + "/embed/captioned/";
  try {
    const res = await fetch(embed, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17 Safari/605.1.15",
      },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Poster frame: the rendered <img class="EmbeddedMediaImage" src="…"> (plain,
    // HTML-escaped URL) — far more reliable than the double-escaped inline JSON.
    const imgSrc = html.match(/<img[^>]*class="EmbeddedMediaImage"[^>]*\ssrc="([^"]+)"/)?.[1];
    const image = imgSrc ? decodeEntities(imgSrc) : undefined;

    // Author + caption from the rendered <div class="Caption"> block.
    const username =
        html.match(/class="CaptionUsername"[^>]*>([^<]+)</)?.[1]?.trim()
        ?? html.match(/EmbeddedMediaImage"[^>]*alt="[^"]*@([\w.]+)/)?.[1];

    let caption: string | undefined;
    const capInner = html.match(/<div class="Caption">([\s\S]*?)<\/div>/)?.[1];
    if (capInner) {
        caption = capInner
            .replace(/<a class="CaptionUsername"[\s\S]*?<\/a>/i, "") // drop the author link
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<[^>]+>/g, "")                                 // strip remaining tags
            .replace(/&nbsp;/g, " ");
        caption = decodeEntities(caption).replace(/^[\s:]+/, "").trim();
        if (caption.length === 0) caption = undefined;
    }

    if (!image && !caption) return null; // embed layout changed / private

    const handle = username ? `@${username}` : "Instagram";
    const firstLine = caption?.split("\n").map((s) => s.trim()).find((s) => s.length > 0)?.slice(0, 90);
    return {
      finalUrl: url,
      title: firstLine ?? handle,
      description: caption,
      image,
      siteName: handle,
    };
  } catch {
    return null;
  }
}

async function fetchMetadata(url: string): Promise<PageMeta> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9",
      "Upgrade-Insecure-Requests": "1",
    },
    signal: AbortSignal.timeout(9000),
  });
  // Even on a non-OK response (some sites 403 a bot but still return usable OG
  // in the body) we parse what we got rather than throwing it away.
  const html = await res.text();
  return extractPageMeta(html, res.url || url);
}

/** Lightweight metadata preview for the share sheet (title/image/author). Same
 *  fetch logic as extractLive, but returns immediately and never persists. */
export async function previewMetadata(
  url: string
): Promise<{ title: string | null; image: string | null; author: string | null }> {
  const host = (() => { try { return new URL(url).host.toLowerCase(); } catch { return ""; } })();

  // Maps: the place name is in the URL — no fetch needed.
  if (host.includes("maps.apple.com") || host.includes("maps.google") || host.startsWith("maps.")) {
    try {
      const u = new URL(url);
      return { title: u.searchParams.get("q") || u.searchParams.get("name") || "Place", image: null, author: null };
    } catch { return { title: null, image: null, author: null }; }
  }

  const isInstagram = host.includes("instagram");
  let meta: PageMeta;
  try {
    if (isInstagram) {
      meta = await fetchMetadata(url);
      if (!meta.image) meta = (await fetchInstagramEmbed(url)) ?? meta;
    } else {
      meta = (await fetchOEmbed(url)) ?? (await fetchMetadata(url));
    }
  } catch {
    return { title: null, image: null, author: null };
  }

  let author: string | null = meta.siteName ?? null;
  let title = meta.title ?? null;
  if (isInstagram && title) {
    const m = title.match(/^@?([\w.]+)\s+on\s+Instagram\s*:\s*([\s\S]*)$/i);
    if (m) {
      author = "@" + m[1];
      const cap = (m[2] ?? "").replace(/^["“]+|["”]+$/g, "").trim();
      title = cap ? cap.slice(0, 90) : "@" + m[1];
    }
  }
  return { title, image: meta.image ?? null, author };
}

function stubExtract(type: string, sourceUrl: string | null) {
  switch (type) {
    case "recipe":
      return {
        title: "One-pan pasta",
        extracted: {
          kind: "recipe",
          ingredients: [
            { qty: "200", unit: "g", item: "spaghetti" },
            { qty: "2", unit: "clove", item: "garlic" },
          ],
          steps: ["Boil the pasta", "Sizzle garlic in oil", "Toss together"],
          serves: 2,
          time_minutes: 20,
        },
      };
    case "place":
      return {
        title: "Sample Café",
        extracted: {
          kind: "place",
          name: "Sample Café",
          address: "123 Main St",
          lat: 51.5074,
          lng: -0.1278,
          google_place_id: null,
          category: "cafe",
        },
      };
    case "link":
      return {
        title: "Resolved link",
        extracted: {
          kind: "link",
          resolved_url: sourceUrl ?? "https://example.com",
          title: "Resolved link",
          description: null,
          og_image: null,
        },
      };
    default:
      return {
        title: "Saved post",
        extracted: { kind: "tags", tags: ["saved"], palette: ["#cccccc"] },
      };
  }
}

/** Run one card fully through the pipeline. Safe to call fire-and-forget. */
export async function runExtraction(cardId: string): Promise<void> {
  if (inFlight.has(cardId)) return;
  inFlight.add(cardId);
  try {
    const card = await one<any>("SELECT * FROM cards WHERE id = $1", [cardId]);
    if (!card) return;

    // Never overwrite a rich email-derived record with a web/stub extract — there
    // is no page to fetch, and the stub would wipe the record + brand logo.
    if (!card.source_url || card.extracted?.kind === "record") {
      await q(`UPDATE cards SET status='ready', updated_at=now() WHERE id = $1`, [cardId]);
      return;
    }

    if (config.EXTRACTION_MODE === "live" && card.source_url) {
      await extractLive(cardId, card);
    } else {
      await extractStub(cardId, card);
    }
    await q(`DELETE FROM card_extraction_state WHERE card_id = $1`, [cardId]);
  } catch (err) {
    await q(
      `UPDATE card_extraction_state SET attempts = attempts + 1, last_error = $2 WHERE card_id = $1`,
      [cardId, String(err)]
    ).catch(() => {});
  } finally {
    inFlight.delete(cardId);
  }
}

/** Deterministic offline pipeline (no secrets, no network). */
async function extractStub(cardId: string, card: any): Promise<void> {
  await delay(STAGE_DELAY_MS);
  await q(
    `UPDATE cards SET status='processing',
       author_handle = COALESCE(author_handle, 'creator'),
       caption = COALESCE(caption, 'Auto-extracted caption'),
       updated_at = now()
     WHERE id = $1`,
    [cardId]
  );
  const type: string = card.type;
  await delay(STAGE_DELAY_MS);
  const { title, extracted } = stubExtract(type, card.source_url);
  await q(
    `UPDATE cards SET type=$2, title=COALESCE(title,$3), extracted=$4::jsonb, updated_at=now()
     WHERE id = $1`,
    [cardId, type, title, JSON.stringify(extracted)]
  );
  await delay(STAGE_DELAY_MS);
  await q(`UPDATE cards SET status='ready', updated_at=now() WHERE id = $1`, [cardId]);
}

/** Live pipeline: fetch OpenGraph metadata for any URL — title, image, domain. */
async function extractLive(cardId: string, card: any): Promise<void> {
  await q(`UPDATE cards SET status='processing', updated_at=now() WHERE id = $1`, [cardId]);

  const srcHost = (() => { try { return new URL(card.source_url).host.toLowerCase(); } catch { return ""; } })();
  const isInstagram = srcHost.includes("instagram");

  // A shared Apple/Google Maps link carries the place name (`q`) and coordinates
  // (`ll`) in the URL — build the place directly, no fetch needed.
  if (srcHost.includes("maps.apple.com") || srcHost.includes("maps.google") || srcHost.startsWith("maps.")) {
    try {
      const u = new URL(card.source_url);
      const name = u.searchParams.get("q") || u.searchParams.get("name") || "Place";
      const ll = (u.searchParams.get("ll") || u.searchParams.get("sll") || "").split(",");
      const lat = ll[0] ? Number(ll[0]) : null;
      const lng = ll[1] ? Number(ll[1]) : null;
      const place = {
        kind: "place",
        name,
        address: u.searchParams.get("address") || null,
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
        // The user's chosen category (seeded at save time) wins over the URL's.
        category: card.extracted?.category || u.searchParams.get("category") || null,
      };
      await q(
        `UPDATE cards SET type='place', title=$2, extracted=$3::jsonb, status='ready', updated_at=now() WHERE id = $1`,
        [cardId, name, JSON.stringify(place)]
      );
      return;
    } catch (err) {
      await scheduleRetryOrFail(cardId, String(err));
      return;
    }
  }

  let meta: PageMeta;
  try {
    // Instagram serves the poster + title in OG meta even when walled; if that
    // ever stops, fall back to the public /embed/captioned/ page. YouTube/TikTok
    // → oEmbed; everything else → OpenGraph scrape.
    if (isInstagram) {
      meta = await fetchMetadata(card.source_url);
      if (!meta.image) meta = (await fetchInstagramEmbed(card.source_url)) ?? meta;
    } else {
      meta = (await fetchOEmbed(card.source_url)) ?? (await fetchMetadata(card.source_url));
    }
  } catch (err) {
    // Transient fetch failure (offline/blocked) — retry with backoff rather than
    // giving up. A failed card is still a card once retries are exhausted.
    await scheduleRetryOrFail(cardId, String(err));
    return;
  }

  // Instagram's OG title is "@user on Instagram: \"caption\"" — split it into a
  // clean caption title + author handle.
  if (isInstagram) {
    const m = meta.title?.match(/^@?([\w.]+)\s+on\s+Instagram\s*:\s*([\s\S]*)$/i);
    if (m) {
      meta.siteName = "@" + m[1];
      const cap = (m[2] ?? "").replace(/^["“]+|["”]+$/g, "").trim();
      meta.title = cap ? cap.slice(0, 90) : "@" + m[1];
      if (cap) meta.description = cap;
    }
  }

  const host = (() => {
    try { return new URL(meta.finalUrl).host.replace(/^www\./, ""); } catch { return null; }
  })();
  const title = meta.title ?? meta.siteName ?? host ?? "Saved link";
  // Keep the user's type guess for filtering; default 'other' to 'link'.
  const type: string = card.type === "other" ? "link" : card.type;

  // Re-host the thumbnail on our bucket so it's stable/fast (falls back to the
  // origin URL if caching fails or storage isn't configured).
  const thumb = meta.image ? (await cacheRemoteImage(meta.image)) ?? meta.image : null;

  // Fold product signals (brand · price) into the description so shopping saves
  // carry context even when the page has a thin OG description.
  const prefix = [meta.brand, meta.price].filter(Boolean).join(" · ");
  const description = prefix
    ? meta.description ? `${prefix} — ${meta.description}` : prefix
    : meta.description ?? null;

  // For place-typed saves, build a place shape (name from the title/caption) so
  // the app can geocode it on-device. Coords are filled in later via PATCH.
  const extracted = type === "place"
    ? {
        kind: "place",
        name: meta.title ?? host ?? "Place",
        address: null,
        lat: null,
        lng: null,
        category: card.extracted?.category ?? null,
      }
    : {
        kind: "link",
        resolved_url: meta.finalUrl,
        title: meta.title ?? null,
        description,
        og_image: thumb,
        price: meta.price ?? null,
        brand: meta.brand ?? null,
      };

  await q(
    `UPDATE cards SET type=$2, title=$3, thumb_url=$4, caption=COALESCE(caption,$5),
       author_handle=COALESCE(author_handle,$6), extracted=$7::jsonb,
       status='ready', updated_at=now()
     WHERE id = $1`,
    [cardId, type, title, thumb, description, meta.siteName ?? null, JSON.stringify(extracted)]
  );
}

/** Periodic sweep: resume any card left pending/processing (e.g. after restart). */
export function startExtractionWorker(): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      const rows = await q<{ id: string }>(
        `SELECT c.id FROM cards c
         LEFT JOIN card_extraction_state s ON s.card_id = c.id
         WHERE c.status IN ('pending','processing')
           AND (s.next_retry_at IS NULL OR s.next_retry_at <= now())
         ORDER BY c.created_at
         LIMIT 20`
      );
      for (const r of rows) void runExtraction(r.id);
    } catch {
      // swallow; next tick retries
    }
  }, 3000);
}
