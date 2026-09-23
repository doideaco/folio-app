// Extraction pipeline. In stub mode it drives the real pending -> processing ->
// ready state machine with deterministic, secret-free extractors, committing
// partial progress between stages so /sync shows the card advancing.

import { q, one } from "./db.js";
import { config } from "./config.js";
import { cacheRemoteImage } from "./storage.js";
import { parseRecipe, looksLikeRecipe, recipeTitle } from "./recipe.js";

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
    .replace(/&nbsp;/gi, " ")
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
  // Generic-product signals (schema.org Product), for non-Shopify shops.
  isProduct?: boolean;
  currency?: string;    // ISO code, e.g. "GBP"
  available?: boolean;  // offers.availability ~ InStock
  compareAt?: string;   // a higher "was" price for a sale strike-through
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

/** A short bold headline from a long social caption: the first sentence/line,
 *  capped — so the card shows a clean title instead of a wall of bold text. */
function headline(text: string, max = 70): string {
  let s = (text.replace(/\r/g, "").split(/\n/)[0] ?? text).trim();
  const sentence = s.match(/^[\s\S]*?[.!?？！]/);
  if (sentence && sentence[0].trim().length >= 12) s = sentence[0].trim();
  if (s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, "").trim() + "…";
  return s.replace(/^["“”]+|["“”]+$/g, "").trim();
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
      const nodeType = ([] as string[]).concat(node["@type"] ?? []).join(",").toLowerCase();
      if (nodeType.includes("product")) out.isProduct = true;
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
      if (node.offers) {
        const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
        const amount = offer?.price ?? offer?.lowPrice;
        if (!out.price && amount != null) out.price = formatPrice(String(amount), offer?.priceCurrency);
        if (!out.currency && offer?.priceCurrency) out.currency = String(offer.priceCurrency);
        const avail = String(offer?.availability ?? "").toLowerCase();
        if (out.available === undefined && avail) {
          out.available = /instock|in_stock|limitedavailability|preorder|backorder/.test(avail);
        }
        // A struck-through "was" price: the high end of a price range above the
        // current price (schema.org has no dedicated compare-at).
        const high = offer?.highPrice;
        if (!out.compareAt && high != null && Number(high) > Number(amount)) {
          out.compareAt = formatPrice(String(high), offer?.priceCurrency);
        }
      }
    }
  }
  return out;
}

/** Normalise a candidate title: collapse whitespace (incl. non-breaking spaces,
 *  e.g. Zara's placeholder `&nbsp;` title) and reject anything too short to be a
 *  real title, so we fall through to the next signal instead of a blank card. */
export function tidyTitle(s?: string): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/[ ​]/g, " ").replace(/\s+/g, " ").trim();
  return t.length >= 2 ? t : undefined;
}

/** Last-resort title from the URL's own slug — turns
 *  `/folding-corduroy-chair-l48336073` into "Folding Corduroy Chair", so pages
 *  with junk/empty metadata still get a readable name. */
export function titleFromURL(url: string): string | undefined {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (!seg) return undefined;
    let s = decodeURIComponent(seg).replace(/\.[a-z0-9]{1,5}$/i, "");
    // Drop a trailing product-code token (e.g. "-l48336073", "-p12345").
    s = s.replace(/[-_]?[a-z]?\d{5,}[a-z0-9]*$/i, "");
    s = s.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    if (s.length < 2 || /^\d+$/.test(s)) return undefined;
    return s.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  } catch { return undefined; }
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
      tidyTitle(metaContent(html, "og:title")) ??
      tidyTitle(metaContent(html, "twitter:title")) ??
      tidyTitle(jsonld.title) ??
      tidyTitle(titleTag) ??
      titleFromURL(finalUrl) ??
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
    isProduct: jsonld.isProduct,
    currency: jsonld.currency,
    available: jsonld.available,
    compareAt: jsonld.compareAt,
  };
}

// --- Shopify product detection ------------------------------------------------
//
// Any Shopify store exposes a product's full data at `/products/<handle>.js`
// (the AJAX API): variants with ids, prices (in cents), per-variant availability,
// and options (Size/Colour) — no API key. We use the variant ids to build a cart
// permalink `…/cart/<id>:1` in the app.

/** Does this URL look like a Shopify-style product page (`/products/<handle>`)? */
function looksLikeProductURL(u: string): boolean {
  try { return /\/products\/[^/?#]+/i.test(new URL(u).pathname); } catch { return false; }
}

/** Strip HTML to a capped plain-text description. */
function stripHtmlText(html: string | null | undefined, max = 500): string | null {
  if (!html) return null;
  const text = decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

/** Map a Shopify product.js payload into our `.product` extract (pure/testable).
 *  `currency` (ISO) comes from the page's JSON-LD when present — product.js has
 *  no currency — and only affects the display symbol. */
export function shopifyJsonToProduct(
  p: any, origin: string, productUrl: string, currency?: string
): Record<string, unknown> | null {
  if (!p || typeof p !== "object" || !Array.isArray(p.variants)) return null;
  const cents = (v: any): number => (typeof v === "number" ? v : Number(v));
  const money = (c: any): string | null => {
    const n = cents(c);
    return Number.isFinite(n) ? formatPrice((n / 100).toFixed(2), currency) : null;
  };
  const img = (u: any): string | undefined => absolutize(typeof u === "string" ? u : u?.src, origin);

  const options = (Array.isArray(p.options) ? p.options : []).map((o: any) =>
    typeof o === "string"
      ? { name: o, values: [] as string[] }
      : { name: String(o?.name ?? ""), values: Array.isArray(o?.values) ? o.values.map(String) : [] }
  );

  const variants = p.variants.map((v: any) => ({
    id: String(v?.id ?? ""),
    title: String(v?.title ?? ""),
    price: money(v?.price),
    available: v?.available !== false,
    options: Array.isArray(v?.options) && v.options.length
      ? v.options.map(String)
      : [v?.option1, v?.option2, v?.option3].filter((x: any) => x != null).map(String),
  }));
  // String-form options carry no values → derive them from the variants.
  options.forEach((o: any, i: number) => {
    if (!o.values.length) o.values = [...new Set(variants.map((v: any) => v.options[i]).filter(Boolean))];
  });

  const priceCentsList = p.variants
    .filter((v: any) => v?.available !== false).map((v: any) => cents(v?.price))
    .filter((n: number) => Number.isFinite(n));
  const minCents = priceCentsList.length ? Math.min(...priceCentsList)
    : Math.min(...p.variants.map((v: any) => cents(v?.price)).filter((n: number) => Number.isFinite(n)));
  const price = money(p.price ?? (Number.isFinite(minCents) ? minCents : undefined));
  const cmpRaw = p.compare_at_price_max ?? p.compare_at_price ?? p.compare_at_price_min;
  const compareAt = Number.isFinite(cents(cmpRaw)) && cents(cmpRaw) > cents(p.price ?? minCents)
    ? money(cmpRaw) : null;

  const images = (Array.isArray(p.images) ? p.images : []).map(img).filter(Boolean) as string[];
  const image = img(p.featured_image) ?? images[0] ?? null;

  return {
    kind: "product",
    title: String(p.title ?? "").trim(),
    description: stripHtmlText(p.description ?? p.body_html),
    product_url: productUrl,
    shop_domain: (() => { try { return new URL(origin).host; } catch { return null; } })(),
    currency: currency ?? null,
    price,
    compare_at_price: compareAt,
    available: p.available !== false && variants.some((v: any) => v.available),
    vendor: p.vendor ? String(p.vendor) : null,
    options,
    variants,
    image,
    images,
    price_history: [],
  };
}

/** The store's base currency from `${origin}/meta.json` — the currency that
 *  `product.js` prices are actually in. Crucially **geo-independent**: a UK store
 *  returns GBP even when we fetch from a US server, unlike the page's JSON-LD
 *  `priceCurrency`, which Shopify localizes to the requester's region. Cached per
 *  origin (a shop's base currency doesn't change). */
/// An ISO-2 country in each currency's home market, used to pin Shopify's
/// presentment (via `?country=`) so product.js prices come back in the store's
/// base currency rather than localized to our server's region.
const currencyCountry: Record<string, string> = {
  GBP: "GB", USD: "US", EUR: "IE", CAD: "CA", AUD: "AU", NZD: "NZ",
  JPY: "JP", SEK: "SE", DKK: "DK", NOK: "NO", CHF: "CH", SGD: "SG",
  HKD: "HK", INR: "IN", ZAR: "ZA", AED: "AE", PLN: "PL",
};

const shopCurrencyCache = new Map<string, string | null>();
async function fetchShopCurrency(origin: string): Promise<string | null> {
  if (shopCurrencyCache.has(origin)) return shopCurrencyCache.get(origin)!;
  let cur: string | null = null;
  try {
    const res = await fetch(`${origin}/meta.json`, {
      redirect: "follow",
      headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok && !(res.headers.get("content-type") ?? "").includes("html")) {
      const data = JSON.parse(await res.text());
      if (typeof data?.currency === "string" && /^[A-Z]{3}$/.test(data.currency)) cur = data.currency;
    }
  } catch { /* fall back to the JSON-LD hint */ }
  shopCurrencyCache.set(origin, cur);
  return cur;
}

/** Fetch + map a Shopify product from a product page URL, or null if the page
 *  isn't a reachable Shopify product (also covers non-Shopify `/products/` URLs,
 *  whose `.js` returns HTML / no `variants`). `currencyHint` (from the page's
 *  JSON-LD) is a fallback; the store's own `/meta.json` currency wins. */
export async function fetchShopifyProduct(
  pageUrl: string, currencyHint?: string
): Promise<Record<string, unknown> | null> {
  let origin: string, handle: string;
  try {
    const u = new URL(pageUrl);
    const m = u.pathname.match(/\/products\/([^/?#]+)/i);
    if (!m) return null;
    origin = u.origin;
    handle = m[1]!;
  } catch { return null; }
  const productUrl = `${origin}/products/${handle}`;
  try {
    // Resolve the store's BASE currency first so we can pin the price fetch to
    // that market. Shopify localizes product.js prices to the requester's region
    // (USD from a US-hosted server), which would pair a USD amount with the base
    // (£) symbol — the "dollar number, £ sign" bug. Passing ?country=<base> makes
    // product.js return base-currency amounts, so symbol and number agree.
    const currency = (await fetchShopCurrency(origin)) ?? currencyHint;
    const country = currency ? currencyCountry[currency] : undefined;
    const jsURL = `${productUrl}.js${country ? `?country=${country}` : ""}`;
    const res = await fetch(jsURL, {
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/json",
        ...(country ? { "Accept-Language": `${country === "GB" ? "en-GB" : "en"},en;q=0.8` } : {}),
      },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return null;
    // Shopify serves product.js as `text/javascript`; only bail on HTML (a
    // non-Shopify `/products/` page). The `variants` guard in the mapper covers
    // anything else that parses but isn't a product.
    if ((res.headers.get("content-type") ?? "").includes("html")) return null;
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { return null; }
    return shopifyJsonToProduct(data, origin, productUrl, currency);
  } catch { return null; }
}

/** Re-check a saved product's live price/availability, for the price-watch
 *  worker. Shopify products re-fetch full variants via `.js`; generic products
 *  re-scrape the page's JSON-LD. Returns null when the item can't be refreshed. */
export async function refetchProduct(
  product: any
): Promise<{ price: string | null; compareAt: string | null; available: boolean | null; variants?: any[]; options?: any[] } | null> {
  const url = product?.product_url;
  if (typeof url !== "string" || !url) return null;
  if (product.shop_domain) {
    const fresh = await fetchShopifyProduct(url, product.currency ?? undefined);
    if (!fresh) return null;
    return {
      price: (fresh.price as string) ?? null,
      compareAt: (fresh.compare_at_price as string) ?? null,
      available: (fresh.available as boolean) ?? null,
      variants: fresh.variants as any[],
      options: fresh.options as any[],
    };
  }
  try {
    const meta = await fetchMetadata(url);
    if (!meta.isProduct && meta.price == null) return null;
    return { price: meta.price ?? null, compareAt: meta.compareAt ?? null, available: meta.available ?? null };
  } catch { return null; }
}

// --- Video (YouTube) ---------------------------------------------------------
//
// A saved YouTube link becomes a clean `.video` card (thumbnail, channel, open in
// the app), gathered on a "Watch Later" board. Keyless via YouTube's oEmbed
// endpoint (title + author_name + thumbnail); duration/views would need the
// YouTube Data API key and are left null.

/** A YouTube host — but NOT music.youtube.com (that routes to the music path). */
function isYouTubeHost(u: string): boolean {
  try {
    const h = new URL(u).host.toLowerCase();
    return (/(?:^|\.)(?:youtube\.com|youtu\.be)$/i.test(h)) && !h.startsWith("music.");
  } catch { return false; }
}
function youtubeKindDetail(u: string): "video" | "short" | "playlist" | "channel" {
  const s = u.toLowerCase();
  if (/\/shorts\//.test(s)) return "short";
  if (/[?&]list=|\/playlist/.test(s)) return "playlist";
  if (/\/channel\/|\/@|\/c\/|\/user\//.test(s)) return "channel";
  return "video";
}

/** Resolve a saved YouTube URL into a `.video` extract via oEmbed (keyless). */
export async function extractYouTube(sourceUrl: string, meta: PageMeta): Promise<Record<string, unknown> | null> {
  const kindDetail = youtubeKindDetail(sourceUrl);
  let title = meta.title ?? null;
  let channel: string | null = null, channelURL: string | null = null;
  let thumb = meta.image ?? null;
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(sourceUrl)}&format=json`, {
      headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const d = await res.json() as any;
      if (d.title) title = d.title;
      channel = d.author_name ?? null;
      channelURL = d.author_url ?? null;
      if (d.thumbnail_url) thumb = d.thumbnail_url;
    }
  } catch { /* fall back to the page metadata */ }
  if (!title) return null;
  return {
    kind: "video",
    kind_detail: kindDetail,
    title,
    channel,
    channel_url: channelURL,
    thumbnail_url: thumb,
    video_url: sourceUrl,
    duration_sec: null,
    views: null,
  };
}

// --- Music (Apple Music / Spotify / YouTube Music / SoundCloud / Tidal) -------
//
// A saved music link becomes a normalized `.music` card that can be previewed and
// opened in whichever service the person uses. The old Odesli/song.link public
// API is deprecated (401 PUBLIC_API_ACCESS_DEPRECATED), so we go iTunes-first:
// Apple Music URLs resolve exactly by catalog id; other services resolve via an
// iTunes catalog search on "artist title" (which gives us a 30s preview, artwork,
// and the canonical Apple Music link, no key). We keep the source service's exact
// link; the app synthesises search links for the rest.

const MUSIC_HOSTS = /(?:^|\.)(?:music\.apple\.com|open\.spotify\.com|spotify\.com|music\.youtube\.com|soundcloud\.com|tidal\.com|deezer\.com)$/i;
function isMusicHost(u: string): boolean {
  try { return MUSIC_HOSTS.test(new URL(u).host.toLowerCase()); } catch { return false; }
}
function musicPlatform(host: string): string {
  if (host.includes("music.apple")) return "appleMusic";
  if (host.includes("spotify")) return "spotify";
  if (host.includes("music.youtube")) return "youtubeMusic";
  if (host.includes("youtube") || host.includes("youtu.be")) return "youtube";
  if (host.includes("soundcloud")) return "soundcloud";
  if (host.includes("tidal")) return "tidal";
  if (host.includes("deezer")) return "deezer";
  return "web";
}
function musicKindDetail(u: string): "song" | "album" | "playlist" {
  const s = u.toLowerCase();
  if (/\/playlist\/|[?&]list=|\/sets\//.test(s)) return "playlist";
  if (/\/album\//.test(s) && !/[?&]i=/.test(s)) return "album";
  return "song";
}

/** Apple Music URL → catalog id + kind (song id is the `i` param on an album URL). */
function parseAppleMusic(u: string): { kind: "song" | "album" | "playlist"; id: string } | null {
  try {
    const url = new URL(u);
    const song = url.searchParams.get("i");
    if (song) return { kind: "song", id: song };
    const p = url.pathname;
    let m = p.match(/\/song\/[^/]+\/(\d+)/i); if (m) return { kind: "song", id: m[1]! };
    m = p.match(/\/playlist\/[^/]+\/(pl\.[A-Za-z0-9-]+)/i); if (m) return { kind: "playlist", id: m[1]! };
    m = p.match(/\/album\/[^/]+\/(\d+)/i); if (m) return { kind: "album", id: m[1]! };
    return null;
  } catch { return null; }
}

async function itunesResults(url: string): Promise<any[]> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const d = await res.json() as any;
    return Array.isArray(d?.results) ? d.results : [];
  } catch { return []; }
}
async function itunesFirst(url: string): Promise<any | null> {
  return (await itunesResults(url))[0] ?? null;
}

/** From a handful of iTunes search hits, pick the one that best matches the saved
 *  track — preferring an exact title and the right artist, and penalising
 *  remix/live/cover/sped-up variants — so a save of "Blinding Lights" doesn't
 *  become "Blinding Lights (Remix)". */
function pickBestSong(results: any[], title: string, artist: string | null): any | null {
  const want = title.toLowerCase().trim();
  const artistFirst = artist ? normTitle(artist).split(" ")[0] : null;
  const score = (r: any): number => {
    const tn = String(r.trackName ?? "").toLowerCase();
    let s = 0;
    if (tn === want) s += 100;
    else if (normTitle(tn) === normTitle(want)) s += 40;
    if (artistFirst && normTitle(String(r.artistName ?? "")).includes(artistFirst)) s += 25;
    if (/\b(remix|sped up|slowed|cover|karaoke|live|instrumental|tribute|made famous)\b/i.test(tn)) s -= 40;
    s -= Math.max(0, tn.length - want.length) * 0.1; // prefer fewer trailing suffixes
    return s;
  };
  let best: any = null, bestScore = -Infinity;
  for (const r of results) { const sc = score(r); if (sc > bestScore) { bestScore = sc; best = r; } }
  return best;
}

/** Upscale an iTunes 100×100 artwork URL to 600×600. */
function bigArtwork(u?: string): string | undefined {
  return typeof u === "string" ? u.replace(/\/\d+x\d+bb\.(jpg|png)/i, "/600x600bb.$1") : undefined;
}

const normTitle = (s: string) => s.toLowerCase().replace(/\(.*?\)|\[.*?\]|feat\.?.*$/g, "").replace(/[^a-z0-9 ]/g, "").trim();

/** Build a `.music` extract object from an iTunes track/collection result. Pure
 *  and unit-testable. Keeps the source service's link and adds Apple Music. */
export function musicFromItunes(
  r: any, opts: { sourceUrl: string; sourcePlatform: string; kindDetail: string }
): Record<string, unknown> | null {
  if (!r) return null;
  const links: { platform: string; url: string }[] = [{ platform: opts.sourcePlatform, url: opts.sourceUrl }];
  const amUrl = r.trackViewUrl ?? r.collectionViewUrl;
  if (amUrl && opts.sourcePlatform !== "appleMusic") links.push({ platform: "appleMusic", url: String(amUrl) });
  return {
    kind: "music",
    kind_detail: opts.kindDetail,
    title: r.trackName ?? r.collectionName ?? "",
    artist: r.artistName ?? null,
    album: r.collectionName ?? null,
    artwork_url: bigArtwork(r.artworkUrl100) ?? r.artworkUrl100 ?? null,
    duration_sec: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : null,
    preview_url: r.previewUrl ?? null,
    apple_music_id: String(r.trackId ?? r.collectionId ?? "") || null,
    links,
    track_count: r.trackCount ?? null,
  };
}

/** Best-effort artist from a music page's OpenGraph. Spotify/Apple format the
 *  description as "Artist · Album · Song · Year" (artist first), sometimes behind
 *  a "Listen to <track> on Spotify." preamble. */
function artistFromMeta(meta: PageMeta): string | null {
  const d = (meta.description ?? "").replace(/^listen to .*? on [a-z .]+?\.\s*/i, "").trim();
  const seg = d.split(/\s*[·|]\s*/)[0]?.trim();
  if (seg && seg.length <= 60 && !/^\d+$/.test(seg) && !/^song$|^single$|^album$/i.test(seg)) return seg;
  const by = d.match(/\bby\s+([^·|,\n]+)/i)?.[1]?.trim();
  return by || null;
}

/** Resolve a saved music URL into a `.music` extract (network + mapping). */
export async function extractMusic(sourceUrl: string, meta: PageMeta, caption: string | null): Promise<Record<string, unknown> | null> {
  const host = (() => { try { return new URL(sourceUrl).host.toLowerCase(); } catch { return ""; } })();
  const platform = musicPlatform(host);
  const kindDetail = musicKindDetail(sourceUrl);
  const country = "gb";

  if (platform === "appleMusic") {
    const am = parseAppleMusic(sourceUrl);
    if (am && am.kind === "song") {
      const r = await itunesFirst(`https://itunes.apple.com/lookup?id=${encodeURIComponent(am.id)}&country=${country}`);
      const built = musicFromItunes(r, { sourceUrl, sourcePlatform: "appleMusic", kindDetail: "song" });
      if (built) return built;
    }
    if (am && am.kind === "album") {
      // Album URL: fetch its tracks. A single (1 track — which is how Apple Music
      // shares an individual single) becomes a proper song WITH a preview; a real
      // album keeps its album card but borrows the first track's preview so the
      // play button works.
      const results = await itunesResults(`https://itunes.apple.com/lookup?id=${encodeURIComponent(am.id)}&entity=song&limit=50&country=${country}`);
      const collection = results.find((x) => x?.wrapperType === "collection") ?? null;
      const songs = results.filter((x) => x?.wrapperType === "track" || x?.kind === "song");
      const first = songs[0] ?? null;
      if (collection && (collection.trackCount === 1 || songs.length === 1) && first) {
        const built = musicFromItunes(first, { sourceUrl, sourcePlatform: "appleMusic", kindDetail: "song" });
        if (built) return built;
      }
      if (collection) {
        const built = musicFromItunes(collection, { sourceUrl, sourcePlatform: "appleMusic", kindDetail: "album" });
        if (built) {
          if (first?.previewUrl) built.preview_url = first.previewUrl;
          return built;
        }
      }
      if (first) {
        const built = musicFromItunes(first, { sourceUrl, sourcePlatform: "appleMusic", kindDetail: "song" });
        if (built) return built;
      }
    }
    // Playlist (or lookup miss): a minimal card from the page's OpenGraph.
    return {
      kind: "music", kind_detail: kindDetail,
      title: meta.title ?? "Playlist", artist: artistFromMeta(meta), album: null,
      artwork_url: meta.image ?? null, duration_sec: null, preview_url: null,
      apple_music_id: null, links: [{ platform: "appleMusic", url: sourceUrl }], track_count: null,
    };
  }

  // Non-Apple service: get title/artist from the page, then find it in the iTunes
  // catalog for a preview + an Apple Music link.
  const title = meta.title ?? caption ?? "";
  const artist = artistFromMeta(meta);
  const term = [artist, title].filter(Boolean).join(" ").trim();
  if (term && kindDetail === "song") {
    const hits = await itunesResults(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=5&country=${country}`);
    const r = pickBestSong(hits, title, artist);
    // Only trust the match when BOTH the title and (if known) the artist overlap,
    // so a search that surfaces a cover/remix doesn't mislabel the song. We keep
    // the original service link + the page's own metadata either way.
    const titleOk = r && normTitle(String(r.trackName ?? "")).split(" ").some((w: string) => w && normTitle(title).includes(w));
    const artistOk = !artist || (r && normTitle(String(r.artistName ?? "")).split(" ").some((w: string) => w && normTitle(artist).includes(w)));
    if (r && titleOk && artistOk) {
      const built = musicFromItunes(r, { sourceUrl, sourcePlatform: platform, kindDetail: "song" });
      if (built) return built;
    }
  }
  // Fallback: a card from the page metadata alone (no preview / Apple Music link).
  if (!title) return null;
  return {
    kind: "music", kind_detail: kindDetail,
    title, artist, album: null,
    artwork_url: meta.image ?? null, duration_sec: null, preview_url: null,
    apple_music_id: null, links: [{ platform, url: sourceUrl }], track_count: null,
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
/** Build a PageMeta from the app's on-device scrape of the *rendered* page
 *  (carried in raw_text as a `__folioPage` JSON). Reuses the same JSON-LD/OG
 *  parser by reconstructing a minimal HTML doc, then overlays the scrape's
 *  explicit price/image/title. Returns null when there's no client page data. */
function metaFromClientPage(rawText: string | null | undefined, url: string): PageMeta | null {
  if (!rawText) return null;
  let d: any;
  try { d = JSON.parse(rawText); } catch { return null; }
  if (!d || d.__folioPage == null) return null;

  const esc = (s: any) => String(s ?? "").replace(/"/g, "&quot;");
  const parts: string[] = [];
  if (d.title) parts.push(`<title>${esc(d.title)}</title>`, `<meta property="og:title" content="${esc(d.title)}">`);
  if (d.description) parts.push(`<meta property="og:description" content="${esc(d.description)}">`);
  if (d.image) parts.push(`<meta property="og:image" content="${esc(d.image)}">`);
  if (d.siteName) parts.push(`<meta property="og:site_name" content="${esc(d.siteName)}">`);
  if (d.ogType) parts.push(`<meta property="og:type" content="${esc(d.ogType)}">`);
  if (Array.isArray(d.jsonld)) for (const s of d.jsonld) parts.push(`<script type="application/ld+json">${s}</script>`);

  const meta = extractPageMeta(parts.join("\n"), typeof d.url === "string" ? d.url : url);
  // The JSON-LD parser only reads price from offers; the scrape may have found a
  // price via meta/selectors — trust it, and a visible price ⇒ it's a product.
  if (!meta.price && d.price) meta.price = formatPrice(String(d.price), d.currency);
  if (!meta.currency && d.currency) meta.currency = String(d.currency);
  if (d.price) meta.isProduct = true;
  if (!meta.image && d.image) meta.image = absolutize(String(d.image), meta.finalUrl);
  return meta;
}

/** Coalesce two metas, preferring `primary` field-by-field (empty ⇒ fall back).
 *  The on-device scrape is primary — it saw the real rendered page. */
function mergeMeta(primary: PageMeta, secondary: PageMeta): PageMeta {
  const pick = <T,>(a: T | undefined, b: T | undefined) =>
    (a !== undefined && a !== null && (a as unknown) !== "" ? a : b);
  return {
    finalUrl: primary.finalUrl || secondary.finalUrl,
    title: tidyTitle(primary.title) ?? tidyTitle(secondary.title) ?? primary.title ?? secondary.title,
    description: pick(primary.description, secondary.description),
    image: pick(primary.image, secondary.image),
    siteName: pick(primary.siteName, secondary.siteName),
    price: pick(primary.price, secondary.price),
    brand: pick(primary.brand, secondary.brand),
    isProduct: primary.isProduct || secondary.isProduct,
    currency: pick(primary.currency, secondary.currency),
    available: primary.available ?? secondary.available,
    compareAt: pick(primary.compareAt, secondary.compareAt),
  };
}

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

  // The app may have scraped the rendered page on-device (Safari share) — the
  // authoritative signal for JS-only / bot-blocked shops (e.g. Zara).
  const clientMeta = metaFromClientPage(card.raw_text, card.source_url);

  let fetched: PageMeta | null = null;
  try {
    // Instagram serves the poster + title in OG meta even when walled; if that
    // ever stops, fall back to the public /embed/captioned/ page. YouTube/TikTok
    // → oEmbed; everything else → OpenGraph scrape.
    if (isInstagram) {
      fetched = await fetchMetadata(card.source_url);
      if (!fetched.image) fetched = (await fetchInstagramEmbed(card.source_url)) ?? fetched;
    } else {
      fetched = (await fetchOEmbed(card.source_url)) ?? (await fetchMetadata(card.source_url));
    }
  } catch (err) {
    // Transient fetch failure (offline/blocked). If the app already handed us the
    // rendered page, use that; otherwise retry with backoff.
    if (!clientMeta) { await scheduleRetryOrFail(cardId, String(err)); return; }
  }

  // Client scrape wins field-by-field (it saw the real page); network fills gaps.
  let meta: PageMeta = clientMeta && fetched ? mergeMeta(clientMeta, fetched)
    : (clientMeta ?? fetched!);

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
  let thumb = meta.image ? (await cacheRemoteImage(meta.image)) ?? meta.image : null;

  // Fold product signals (brand · price) into the description so shopping saves
  // carry context even when the page has a thin OG description.
  const prefix = [meta.brand, meta.price].filter(Boolean).join(" · ");
  const description = prefix
    ? meta.description ? `${prefix} — ${meta.description}` : prefix
    : meta.description ?? null;

  // Recipe: social recipe posts list ingredients + method in the caption. When
  // it looks like a recipe (or the type guess said so), parse it into a structured
  // recipe so the app renders the real recipe card. Only takes effect when parsing
  // is confident (≥3 ingredients); otherwise we fall through to the link shape.
  const recipeCaption = meta.description ?? card.caption ?? null;
  const parsedRecipe =
    type !== "place" && (card.type === "recipe" || looksLikeRecipe(recipeCaption))
      ? parseRecipe(recipeCaption)
      : null;

  // Music: an Apple Music / Spotify / YouTube Music / … link → a previewable,
  // service-agnostic music card.
  const music = (!parsedRecipe && type !== "place" && isMusicHost(meta.finalUrl))
    ? await extractMusic(meta.finalUrl, meta, card.caption).catch(() => null)
    : null;

  // A YouTube video → a clean `.video` card (Watch Later board).
  const video = (!parsedRecipe && type !== "place" && !music && isYouTubeHost(meta.finalUrl))
    ? await extractYouTube(meta.finalUrl, meta).catch(() => null)
    : null;

  // Shopping: a Shopify product (full variants via `/products/<handle>.js`) or a
  // generic schema.org Product. Only for non-recipe, non-place saves.
  const shopifyProduct = (!parsedRecipe && type !== "place" && !music && !video && looksLikeProductURL(meta.finalUrl))
    ? await fetchShopifyProduct(meta.finalUrl, meta.currency).catch(() => null)
    : null;

  let finalType = type;
  let finalTitle = title;
  let finalDescription = description;
  let extracted: Record<string, unknown>;
  if (parsedRecipe) {
    finalType = "recipe";
    finalTitle = recipeTitle(recipeCaption, title);
    extracted = {
      kind: "recipe",
      ingredients: parsedRecipe.ingredients,
      steps: parsedRecipe.steps,
      serves: null,
      time_minutes: null,
    };
  } else if (type === "place") {
    // For place-typed saves, build a place shape (name from the title/caption) so
    // the app can geocode it on-device. Coords are filled in later via PATCH.
    extracted = {
      kind: "place",
      name: meta.title ?? host ?? "Place",
      address: null,
      lat: null,
      lng: null,
      category: card.extracted?.category ?? null,
    };
  } else if (music) {
    // A previewable, service-agnostic music card.
    finalType = "link";
    finalTitle = (music.title as string) || finalTitle;
    finalDescription = [music.artist, music.album].filter(Boolean).join(" · ") || finalDescription;
    if (music.artwork_url) {
      thumb = (await cacheRemoteImage(music.artwork_url as string)) ?? (music.artwork_url as string) ?? thumb;
      music.artwork_url = thumb;
    }
    extracted = music;
  } else if (shopifyProduct || meta.isProduct) {
    // A shoppable product. Shopify gives full variants; a generic schema.org
    // Product gives price/availability but no variants (Buy opens the page).
    const prod: Record<string, any> = shopifyProduct ?? {
      kind: "product",
      title: meta.title ?? host ?? "Product",
      description: meta.description ?? null,
      product_url: meta.finalUrl,
      shop_domain: null,
      currency: meta.currency ?? null,
      price: meta.price ?? null,
      compare_at_price: meta.compareAt ?? null,
      available: meta.available ?? null,
      vendor: meta.brand ?? null,
      options: [],
      variants: [],
      image: meta.image ?? null,
      images: meta.image ? [meta.image] : [],
      price_history: [],
    };
    // Prefer the cached OG thumbnail for a stable hero; else cache a product image.
    if (!thumb && Array.isArray(prod.images) && prod.images[0]) {
      thumb = (await cacheRemoteImage(prod.images[0])) ?? prod.images[0];
    }
    prod.image = thumb ?? prod.image ?? null;
    finalTitle = (prod.title as string) || finalTitle;
    finalDescription = (prod.description as string | null) ?? finalDescription;
    extracted = prod;
  } else if (video) {
    // A YouTube video card.
    finalType = "link";
    finalTitle = (video.title as string) || finalTitle;
    if (video.thumbnail_url) {
      thumb = (await cacheRemoteImage(video.thumbnail_url as string)) ?? (video.thumbnail_url as string) ?? thumb;
      video.thumbnail_url = thumb;
    }
    extracted = video;
  } else {
    // Social captions (TikTok/IG) arrive as a long title → show a clean bold
    // headline and move the full caption into the body, not the title.
    if ((meta.title?.length ?? 0) > 80) {
      finalTitle = headline(meta.title!);
      finalDescription = [meta.title, description].filter(Boolean).join("\n\n");
    }
    extracted = {
      kind: "link",
      resolved_url: meta.finalUrl,
      title: finalTitle,
      description: finalDescription,
      og_image: thumb,
      price: meta.price ?? null,
      brand: meta.brand ?? null,
    };
  }

  await q(
    `UPDATE cards SET type=$2, title=$3, thumb_url=$4, caption=COALESCE(caption,$5),
       author_handle=COALESCE(author_handle,$6), extracted=$7::jsonb,
       status='ready', updated_at=now()
     WHERE id = $1`,
    [cardId, finalType, finalTitle, thumb, finalDescription, meta.siteName ?? null, JSON.stringify(extracted)]
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
