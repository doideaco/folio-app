// Turn a forwarded email into a Folio card. Travel/booking emails are unusually
// structured: most embed schema.org JSON-LD (FlightReservation, LodgingReservation,
// EventReservation…) — the same markup that powers Gmail's trip cards — and often
// attach a .ics calendar. We parse those first (free, no LLM), then fall back to
// subject/sender heuristics. The board is chosen from the content.

import { brandDomain } from "./brands.js";

export interface InboundAttachment {
  filename?: string;
  mimeType?: string;
  contentBase64?: string;
}

export interface InboundEmail {
  to: string;
  from?: string;
  subject?: string;
  html?: string;
  text?: string;
  /** Original message date (RFC-2822 or ISO). Used for reconciliation chronology
   *  and year inference; falls back to now when absent. */
  date?: string;
  attachments?: InboundAttachment[];
}

export interface ParsedInbound {
  boardName: string;
  boardEmoji: string;
  cardType: "place" | "link" | "other";
  title: string;
  caption: string | null;
  extracted: Record<string, unknown>;
  sourceUrl: string | null;
  /** An image attachment to re-host as the thumbnail, if any. */
  thumb: { base64: string; mimeType: string } | null;
  /** The one actionable date (ISO), stored on the card's `event_at` so it drives
   *  the Agenda + reminders. Mirrors any `date` inside a `.record` extract. */
  eventAt?: string | null;
  /** Registrable brand domain (for logo lookup), e.g. "booking.com". */
  providerDomain?: string | null;
}

const BOARD = {
  trips: { boardName: "Trips", boardEmoji: "✈️" },
  events: { boardName: "Events", boardEmoji: "🎫" },
  orders: { boardName: "Orders", boardEmoji: "📦" },
  inbox: { boardName: "Inbox", boardEmoji: "📥" },
} as const;

/** A labelled detail row on a `.record` (mirrors Swift `RecordField`). */
interface Field { label: string; value: string; copyable: boolean }

/** Assemble a `ParsedInbound` around a normalized `.record` extract — the same
 *  shape the on-device engine produces and `RecordDetail` renders. */
function recordCard(opts: {
  board: { boardName: string; boardEmoji: string };
  recordKind: string;
  title: string;
  subtitle?: string | null;
  dateLabel?: string | null;
  date?: string | null;      // ISO
  fields?: Field[];
  place?: { name: string; address?: string | null; category?: string | null } | null;
  amount?: string | null;
  actionUrl?: string | null;
  provider?: string | null;
  status?: string | null;
  notice?: string | null;
  brandDomain?: string | null;
  caption?: string | null;
  sourceUrl: string | null;
  thumb: ParsedInbound["thumb"];
}): ParsedInbound {
  const extracted: Record<string, unknown> = {
    kind: "record",
    record_kind: opts.recordKind,
    title: opts.title,
  };
  if (opts.subtitle) extracted.subtitle = opts.subtitle;
  if (opts.dateLabel) extracted.date_label = opts.dateLabel;
  if (opts.date) extracted.date = opts.date;
  if (opts.fields && opts.fields.length) extracted.fields = opts.fields;
  if (opts.amount) extracted.amount = opts.amount;
  if (opts.actionUrl) extracted.action_url = opts.actionUrl;
  if (opts.provider) extracted.provider = opts.provider;
  if (opts.status) extracted.status = opts.status;
  if (opts.notice) extracted.notice = opts.notice;
  if (opts.place) {
    const p: Record<string, unknown> = { name: opts.place.name };
    if (opts.place.address) p.address = opts.place.address;
    if (opts.place.category) p.category = opts.place.category;
    extracted.place = p;
  }
  return {
    boardName: opts.board.boardName,
    boardEmoji: opts.board.boardEmoji,
    cardType: "other",
    title: opts.title.slice(0, 300),
    caption: (opts.caption ?? opts.subtitle ?? null),
    extracted,
    sourceUrl: opts.sourceUrl,
    thumb: opts.thumb,
    eventAt: opts.date ?? null,
    providerDomain: opts.brandDomain ?? null,
  };
}

// ---- helpers ---------------------------------------------------------------

function collectJsonLd(html?: string): any[] {
  if (!html) return [];
  const out: any[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse((m[1] ?? "").trim());
      const nodes = Array.isArray(data) ? data : data?.["@graph"] ? data["@graph"] : [data];
      for (const n of nodes) if (n && typeof n === "object") out.push(n);
    } catch { /* skip malformed block */ }
  }
  return out;
}

function typeOf(node: any): string {
  return ([] as string[]).concat(node?.["@type"] ?? []).join(",").toLowerCase();
}

function firstUrl(text?: string, html?: string): string | null {
  const hay = `${text ?? ""}\n${html ?? ""}`;
  const m = hay.match(/https?:\/\/[^\s"'<>)]+/);
  return m ? m[0] : null;
}

// Turn HTML into line-structured text. Block boundaries (and table cells)
// become newlines so a label and its value land on separate lines — the same
// stacked shape the line-based extractors expect — rather than one flat blob.
function stripHtml(html?: string): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|td|th|li|h[1-6]|table|thead|tbody|section|article|header|footer|ul|ol)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return " "; } })
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function fmtDate(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleString("en-GB", {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  });
}

function placeAddress(place: any): string | null {
  if (!place) return null;
  if (typeof place.address === "string") return place.address;
  const a = place.address;
  if (a && typeof a === "object") {
    return [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry]
      .filter((s) => typeof s === "string" && s).join(", ") || null;
  }
  return typeof place.name === "string" ? place.name : null;
}

function firstImageAttachment(atts?: InboundAttachment[]): ParsedInbound["thumb"] {
  const img = (atts ?? []).find((a) => (a.mimeType ?? "").toLowerCase().startsWith("image/") && a.contentBase64);
  return img ? { base64: img.contentBase64!, mimeType: img.mimeType! } : null;
}

// ---- .ics --------------------------------------------------------------------

function parseIcs(atts?: InboundAttachment[]): { summary?: string; start?: string; location?: string } | null {
  const ics = (atts ?? []).find(
    (a) => (a.mimeType ?? "").toLowerCase().includes("calendar") || (a.filename ?? "").toLowerCase().endsWith(".ics")
  );
  if (!ics?.contentBase64) return null;
  let body = "";
  try { body = Buffer.from(ics.contentBase64, "base64").toString("utf8"); } catch { return null; }
  const get = (key: string) => body.match(new RegExp(`^${key}[^:]*:(.*)$`, "mi"))?.[1]?.trim();
  const summary = get("SUMMARY");
  const dt = get("DTSTART");
  const location = get("LOCATION")?.replace(/\\,/g, ",");
  if (!summary && !dt) return null;
  // DTSTART like 20260312T180000Z → ISO
  let start: string | undefined;
  if (dt) {
    const m = dt.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
    if (m) start = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`;
  }
  return { summary, start, location };
}

// ---- forwarded-email handling ------------------------------------------------

/** Strip leading Fwd:/FW:/Re: prefixes (repeatedly). */
function stripFwd(s: string): string {
  let out = (s ?? "").trim();
  while (/^\s*(fwd?|fw|re)\s*:\s*/i.test(out)) out = out.replace(/^\s*(fwd?|fw|re)\s*:\s*/i, "").trim();
  return out;
}

/** When a user manually forwards, the envelope From is *them* and the subject is
 *  "Fwd: …". Recover the original sender + subject from the quoted forwarded
 *  header block so travel/sender heuristics work against the real source. */
function unwrapForwarded(email: InboundEmail): { subject: string; from: string; text: string } {
  const text = (email.text?.trim() || stripHtml(email.html));
  let subject = stripFwd(email.subject ?? "");
  let from = (email.from ?? "").toLowerCase();
  const origFrom =
    text.match(/\bFrom:\s*[^\n<]*<([^>\s]+@[^>\s]+)>/i)?.[1] ??
    text.match(/\bFrom:\s*([^\s<]+@[^\s>]+)/i)?.[1];
  if (origFrom) from = origFrom.toLowerCase();
  if (!subject) {
    const origSubject = text.match(/\bSubject:\s*(.+)/i)?.[1]?.trim();
    if (origSubject) subject = stripFwd(origSubject);
  }
  return { subject, from, text };
}

/** Best-effort check-in/out dates from a booking body (no JSON-LD). */
function extractStayDates(text: string): string | null {
  // Grab the rest of the "Check-in …" line (dates come in many formats).
  const pat = (kind: string) =>
    text.match(new RegExp(`check[\\s-]?${kind}\\b[^A-Za-z0-9\\n]{0,6}([A-Za-z0-9][^\\n]{2,38})`, "i"))?.[1]
      ?.replace(/\s+/g, " ").trim();
  const ci = pat("in");
  const co = pat("out");
  const parts = [ci && `In ${ci}`, co && `Out ${co}`].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** Try to pull a property/venue name out of a confirmation subject line. */
function nameFromSubject(subject: string): string | null {
  // "Booking confirmed: <Name>" / "Your tickets: <Name>" → text after last colon.
  if (subject.includes(":")) {
    const after = subject.split(":").pop()!.trim();
    if (after.length > 2 && !/^(confirmed|reservation|booking|confirmation)$/i.test(after)) {
      return after.slice(0, 80);
    }
  }
  // "<Name> - Booking Confirmation"
  const dash = subject.match(/^(.+?)\s*[-–—]\s*(?:booking|reservation|confirmation|confirmed|tickets?)/i)?.[1]?.trim();
  return dash && dash.length > 2 ? dash.slice(0, 80) : null;
}

/** A readable body snippet with forwarded-header noise (From:/Subject:/…) removed. */
function cleanSnippet(text: string): string | null {
  const cleaned = text
    .replace(/-{2,}\s*forwarded message\s*-{2,}/gi, "")
    .split("\n")
    .filter((l) => !/^\s*(from|to|date|subject|sent|cc|reply-to|begin forwarded)/i.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 200) || null;
}

// ---- main --------------------------------------------------------------------

export function parseInboundEmail(email: InboundEmail, opts?: { now?: Date }): ParsedInbound {
  const { subject, from, text: bodyText } = unwrapForwarded(email);
  const thumb = firstImageAttachment(email.attachments);
  const sourceUrl = firstUrl(email.text, email.html);
  const nodes = collectJsonLd(email.html);

  // 1) Structured reservation from JSON-LD.
  const reservation = nodes.find((n) => typeOf(n).includes("reservation"));
  if (reservation) {
    const t = typeOf(reservation);
    const forItem = reservation.reservationFor ?? {};

    if (t.includes("flight")) {
      const airline = forItem.airline?.name ?? forItem.airline?.iataCode ?? "Flight";
      const num = forItem.flightNumber ?? "";
      const dep = forItem.departureAirport?.iataCode ?? forItem.departureAirport?.name ?? "";
      const arr = forItem.arrivalAirport?.iataCode ?? forItem.arrivalAirport?.name ?? "";
      const when = fmtDate(forItem.departureTime);
      return {
        ...BOARD.trips, cardType: "link",
        title: `✈️ ${airline} ${num}`.trim() + (dep && arr ? ` · ${dep}→${arr}` : ""),
        caption: [when, reservation.reservationNumber && `Ref ${reservation.reservationNumber}`].filter(Boolean).join(" · ") || null,
        extracted: {
          kind: "link", resolved_url: sourceUrl ?? "", kind_detail: "flight",
          airline: typeof airline === "string" ? airline : null,
          flight_number: num || null, origin: dep || null, destination: arr || null,
        },
        sourceUrl, thumb,
      };
    }
    if (t.includes("lodging")) {
      const name = forItem.name ?? "Hotel";
      const addr = placeAddress(forItem);
      const ci = fmtDate(reservation.checkinDate ?? reservation.checkinTime);
      const co = fmtDate(reservation.checkoutDate ?? reservation.checkoutTime);
      return {
        ...BOARD.trips, cardType: addr ? "place" : "link",
        title: `🏨 ${name}`,
        caption: [ci && `In ${ci}`, co && `Out ${co}`].filter(Boolean).join(" · ") || null,
        extracted: addr
          ? { kind: "place", name, address: addr, category: "hotel" }
          : { kind: "link", resolved_url: sourceUrl ?? "", kind_detail: "lodging" },
        sourceUrl, thumb,
      };
    }
    if (t.includes("event")) {
      const name = forItem.name ?? subject ?? "Event";
      const loc = forItem.location;
      const addr = placeAddress(loc);
      const when = fmtDate(forItem.startDate);
      return {
        ...BOARD.events, cardType: addr ? "place" : "link",
        title: `🎫 ${name}`,
        caption: [when, loc?.name].filter(Boolean).join(" · ") || null,
        extracted: addr
          ? { kind: "place", name: loc?.name ?? name, address: addr, category: "venue" }
          : { kind: "link", resolved_url: sourceUrl ?? "", kind_detail: "event" },
        sourceUrl, thumb,
      };
    }
    if (t.includes("foodestablishment")) {
      const name = forItem.name ?? "Restaurant";
      const addr = placeAddress(forItem);
      const when = fmtDate(reservation.startTime);
      return {
        ...BOARD.trips, cardType: addr ? "place" : "link",
        title: `🍽️ ${name}`,
        caption: when,
        extracted: addr ? { kind: "place", name, address: addr, category: "restaurant" } : { kind: "link", resolved_url: sourceUrl ?? "" },
        sourceUrl, thumb,
      };
    }
  }

  // 2) .ics calendar attachment (flights/events often include one).
  const ics = parseIcs(email.attachments);
  if (ics?.summary) {
    const when = fmtDate(ics.start);
    const board = /concert|gig|show|tour|festival/i.test(ics.summary) ? BOARD.events : BOARD.trips;
    return {
      ...board, cardType: ics.location ? "place" : "link",
      title: ics.summary,
      caption: [when, ics.location].filter(Boolean).join(" · ") || null,
      extracted: ics.location
        ? { kind: "place", name: ics.summary, address: ics.location }
        : { kind: "link", resolved_url: sourceUrl ?? "" },
      sourceUrl, thumb,
    };
  }

  // 3) Provider-aware deterministic records (works for every device, no LLM).
  //    These marketing/confirmation emails rarely embed JSON-LD, so we deep-parse
  //    the rendered text into a normalized `.record` extract.
  const now = opts?.now ?? new Date();
  const cleanText = stripForwardHeaders(bodyText);
  const rec =
    extractFlight(subject, from, cleanText, sourceUrl, thumb, now) ??
    extractLodging(subject, from, cleanText, sourceUrl, thumb, now) ??
    extractOrder(subject, from, cleanText, sourceUrl, thumb, now);
  if (rec) return rec;

  // 4) Heuristics on the (un-forwarded) subject + original sender + body text.
  const hay = `${subject} ${from} ${bodyText.slice(0, 500)}`.toLowerCase();
  const isLodging = /(hotel|booking\.com|airbnb|hostel|resort|marriott|hilton|premier inn|travelodge|check-?in|check-?out|nights? stay)/.test(hay);
  const isTrip = isLodging || /(flight|boarding|itinerary|reservation|expedia|ryanair|easyjet|british airways|lufthansa|train|eurostar|trainline|rental car|car hire)/.test(hay);
  const isEvent = /(ticket|concert|gig|tour|festival|ticketmaster|dice\.fm|eventbrite|seatgeek|axs\.com)/.test(hay);
  const snippet = cleanSnippet(bodyText);

  // Shared best-effort fields for the generic event/trip records below. Dates are
  // taken only from a clearly-labelled line (never a blind scan) so we don't
  // surface a wrong date; precise per-provider extraction comes with fixtures.
  const genLines = lineList(stripForwardHeaders(bodyText));
  const genRef = valueAfter(genLines, /order\s*(number|no\.?|#|confirmation)|ticket\s*(number|no\.?|#)|booking\s*(reference|ref)/i)
      ?.match(/[A-Z0-9]{5,}/i)?.[0]
    ?? subject.match(/\b(?:order|booking|ref(?:erence)?)\s+([A-Z0-9]{5,})/i)?.[1]
    ?? null;
  const genWhen = parseWhen(valueAfter(genLines, /event date|^date\b|^when\b|departure|^depart/i), now);

  if (isEvent) {
    const name = nameFromSubject(subject) ?? subject;
    const provider = merchantName(from, subject);
    const venue = valueAfter(genLines, /^(venue|location|where)\b/i);
    const fields: Field[] = [];
    if (genRef) fields.push({ label: "Order #", value: genRef, copyable: true });
    if (venue) fields.push({ label: "Venue", value: venue.slice(0, 80), copyable: false });
    return recordCard({
      board: BOARD.events, recordKind: "event",
      title: `🎫 ${name || "Event"}`.slice(0, 140),
      subtitle: venue ?? snippet,
      dateLabel: genWhen ? "Starts" : null, date: genWhen?.iso ?? null,
      fields, provider, status: "Booked",
      brandDomain: brandDomain(provider, from),
      actionUrl: sourceUrl, sourceUrl, thumb,
    });
  }

  if (isTrip) {
    const name = nameFromSubject(subject) ?? subject;
    const isTrain = /\b(train|eurostar|trainline|rail|lner|avanti|gwr)\b/i.test(hay);
    const provider = merchantName(from, subject);
    const fields: Field[] = [];
    if (genRef) fields.push({ label: "Booking ref", value: genRef, copyable: true });
    return recordCard({
      board: BOARD.trips, recordKind: isTrain ? "trip" : "trip",
      title: `${isLodging ? "🏨" : isTrain ? "🚆" : "✈️"} ${name || (isLodging ? "Hotel booking" : "Trip")}`.slice(0, 140),
      subtitle: extractStayDates(bodyText) ?? snippet,
      dateLabel: genWhen ? "Departs" : null, date: genWhen?.iso ?? null,
      fields, provider, status: "Booked",
      brandDomain: brandDomain(provider, from),
      actionUrl: sourceUrl, sourceUrl, thumb,
    });
  }

  return {
    ...BOARD.inbox, cardType: "link",
    title: (subject || "Forwarded email").slice(0, 140),
    caption: snippet,
    extracted: { kind: "link", resolved_url: sourceUrl ?? "", from },
    sourceUrl, thumb,
  };
}

// ---- record extraction helpers ----------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
  january: 0, february: 1, march: 2, april: 3, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/** Drop the quoted forwarded-header block (From:/Subject:/Date:/To:/…) so its
 *  values don't leak into refs and dates. Handled per-line since Apple Mail
 *  interleaves them with the body. */
function stripForwardHeaders(text: string): string {
  return text
    .replace(/-{2,}\s*forwarded message\s*-{2,}/gi, "")
    .split(/\r?\n/)
    // Strip quote markers ("> ", ">> ") that quote-style forwards prepend to every
    // line — otherwise line-anchored label matching (^Check-in, ^Order number) fails.
    .map((l) => l.replace(/^\s*(?:>\s?)+/, ""))
    // Only strip header lines that carry an inline value (the quoted envelope),
    // so a body field like Ryanair's bare "Date:" (value on the next line) stays.
    .filter((l) => !/^\s*(from|to|cc|bcc|reply-to|sent|subject|date)\s*:\s*\S/i.test(l))
    .join("\n");
}

/** Split body text into trimmed, non-empty lines. */
function lineList(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.replace(/ /g, " ").trim()).filter(Boolean);
}

/** The value for a label. Handles all three real-world shapes:
 *   - "Label: value"            (colon right after the label)
 *   - "Label value"             (space-separated, no colon — real MIME plain text)
 *   - "Label" \n "value"        (stacked, as rendered HTML tables/RTF give us)
 *  A colon only counts as a separator when it sits immediately after the label,
 *  so a time in the value ("15:00") is never mistaken for one. A bare weekday
 *  value absorbs the following line (Airbnb splits weekday and date). */
function valueAfter(lines: string[], labelRe: RegExp): string | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = labelRe.exec(line);
    if (!m) continue;
    const afterLabel = line.slice(m.index + m[0].length);
    const sep = afterLabel.match(/^\s*[:：]\s*/);
    if (sep) {
      const v = afterLabel.slice(sep[0].length).trim();
      if (v) return v;
    } else {
      const inline = afterLabel.replace(/^\s*[-–]\s*/, "").trim();
      if (inline) return inline;
    }
    let v = (lines[i + 1] ?? "").trim();
    if (/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?$/i.test(v) && lines[i + 2]) {
      v = `${v} ${lines[i + 2]!.trim()}`;
    }
    return v || null;
  }
  return null;
}

function mkISO(y: number, mo: number, d: number, hh: number, mm: number): string {
  return new Date(Date.UTC(y, mo, d, hh, mm)).toISOString();
}

/** Year for a month/day when the source omits it: the nearest sensible year,
 *  preferring the future (a date >1 week past is assumed to be next year). */
function inferYear(monthIdx: number, day: number, now: Date): number {
  const y = now.getUTCFullYear();
  const cand = Date.UTC(y, monthIdx, day);
  return cand < now.getTime() - 7 * 864e5 ? y + 1 : y;
}

/** Parse the many date shapes these emails use into an ISO instant.
 *  Handles: 2026-09-10 · 08/09/26 · "21 Feb 2026" · "February 17, 2023" ·
 *  "June 3, 2026" · "Mon, 03 Aug 26" · "Fri 26 Jun" (year inferred), with an
 *  optional "HH:MM" (+ am/pm). Returns null when no date is found. */
function parseWhen(input: string | null | undefined, now: Date): { iso: string; hasTime: boolean } | null {
  if (!input) return null;
  const s = input.replace(/ /g, " ").trim();

  const time = s.match(/\b(\d{1,2}):(\d{2})\b/);
  let hh = time ? +time[1]! : 0;
  const mm = time ? +time[2]! : 0;
  if (time && /pm/i.test(s) && hh < 12) hh += 12;
  if (time && /am/i.test(s) && hh === 12) hh = 0;

  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return { iso: mkISO(+iso[1]!, +iso[2]! - 1, +iso[3]!, hh, mm), hasTime: !!time };

  const dmy = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/); // UK dd/mm/yy
  if (dmy) {
    let y = +dmy[3]!;
    if (y < 100) y += 2000;
    return { iso: mkISO(y, +dmy[2]! - 1, +dmy[1]!, hh, mm), hasTime: !!time };
  }

  const monRe = new RegExp(`\\b(${Object.keys(MONTHS).join("|")})\\b`, "i");
  const mon = s.match(monRe);
  if (mon) {
    const monName = mon[1]!.toLowerCase();
    const monthIdx = MONTHS[monName]!;
    const noTime = s.replace(/\b\d{1,2}:\d{2}\b/g, " ");
    const tokens = noTime.split(/[\s,]+/).filter(Boolean);
    const norm = (t: string) => t.replace(/[^a-z]/gi, "").toLowerCase();
    const i = tokens.findIndex((t) => norm(t) === monName);
    const num = (t?: string) => {
      const x = (t ?? "").replace(/(st|nd|rd|th)$/i, "");
      return /^\d{1,4}$/.test(x) ? +x : NaN;
    };
    const prev = num(tokens[i - 1]);
    const next = num(tokens[i + 1]);
    const day = prev >= 1 && prev <= 31 ? prev : (next >= 1 && next <= 31 ? next : NaN);
    if (!Number.isFinite(day)) return null;

    let year = NaN;
    const y4 = tokens.find((t) => /^\d{4}$/.test(t));
    if (y4) year = +y4;
    else {
      const cands = [num(tokens[i + 1]), num(tokens[i + 2])].filter((n) => n >= 0 && n <= 99 && n !== day);
      year = cands.length ? 2000 + cands[0]! : inferYear(monthIdx, day, now);
    }
    return { iso: mkISO(year, monthIdx, day, hh, mm), hasTime: !!time };
  }
  return null;
}

/** Normalize a money mention to a symbol + amount, e.g. "204.69 GBP" → "£204.69". */
function money(s: string | null | undefined): string | null {
  if (!s) return null;
  const sym = s.match(/[£€$]\s?\d[\d,]*(?:\.\d{2})?/);
  if (sym) return sym[0].replace(/\s+/g, "");
  // Lookbehind guards against matching the tail of a longer decimal (e.g. an FX
  // rate "0.90780 GBP" must not read as "90780 GBP").
  const iso = s.match(/(?<![\d.])(\d[\d,]*(?:\.\d{2})?)\s?(GBP|EUR|USD)\b/i);
  if (iso) {
    const map: Record<string, string> = { GBP: "£", EUR: "€", USD: "$" };
    return (map[iso[2]!.toUpperCase()] ?? "") + iso[1]!;
  }
  return null;
}

/** Money on the first line matching `labelRe`, or on the line right after it
 *  (receipts split "Total paid …" from its "204.69 GBP" value). */
function moneyNear(lines: string[], labelRe: RegExp): string | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!labelRe.test(line)) continue;
    const m = money(line) ?? money(lines[i + 1] ?? "");
    if (m) return m; // keep scanning past a bare label ("Payment details")
  }
  return null;
}

/** The first passenger/guest name (MR/MRS/MS ...) in a booking body. */
function firstName(lines: string[]): string | null {
  for (const l of lines) {
    const m = l.match(/^(?:mr|mrs|ms|miss|dr)\.?\s+([A-Za-z][A-Za-z '\-]{2,40})$/i);
    if (m) return l.replace(/\s+/g, " ").trim();
  }
  return null;
}

/** A friendly merchant name from the sender domain / display name. */
function merchantName(from: string, subject: string): string {
  const domain = (from.split("@")[1] ?? "").toLowerCase();
  const map: Record<string, string> = {
    flatspot: "Flatspot", spacenk: "Space NK", tradeinn: "Tradeinn",
    amazon: "Amazon", asos: "ASOS", nike: "Nike", etsy: "Etsy",
  };
  for (const key of Object.keys(map)) if (domain.includes(key)) return map[key]!;
  const core = domain.replace(/^(www|mail|news|orders?|newsletter|email|e|reply|no-?reply)\./g, "").split(".")[0];
  return core ? core.charAt(0).toUpperCase() + core.slice(1) : "Order";
}

// ---- record extractors -------------------------------------------------------

interface Airline { name: string; flightRe: RegExp; }

function airlineFor(from: string, subject: string, body: string): Airline | null {
  const hay = `${from} ${subject} ${body.slice(0, 400)}`.toLowerCase();
  if (/ryanair/.test(hay)) return { name: "Ryanair", flightRe: /\bFR\s?\d{2,4}\b/g };
  if (/easyjet/.test(hay)) return { name: "easyJet", flightRe: /\bEZY\s?\d{3,4}\b/g };
  if (/british airways|\bba\.com\b|@.*\bba\b/.test(hay) || /\bba\d{3,4}\b/.test(hay))
    return { name: "British Airways", flightRe: /\bBA\s?\d{3,4}\b/g };
  return null;
}

function extractFlight(
  subject: string, from: string, body: string, sourceUrl: string | null,
  thumb: ParsedInbound["thumb"], now: Date
): ParsedInbound | null {
  const airline = airlineFor(from, subject, body);
  if (!airline) return null;
  const lines = lineList(body);
  const hay = `${subject}\n${body}`;

  // Flight numbers, in order, de-duplicated.
  const flights = Array.from(new Set((hay.match(airline.flightRe) ?? []).map((f) => f.replace(/\s+/g, ""))));

  // Booking reference: explicit label, else a 6–7 char code in the subject.
  const refRaw =
    valueAfter(lines, /^(booking reference|reservation|booking ref)\b/i) ??
    subject.match(/\b(?:booking(?:\s+reference)?|ref(?:erence)?|reservation)\b[:\s]+([A-Z0-9]{5,7})\b/i)?.[1] ??
    subject.match(/\b([A-Z0-9]{6,7})\b/)?.[1] ??
    null;
  const ref = refRaw ? (refRaw.match(/\b([A-Z0-9]{5,7})\b/)?.[1] ?? refRaw.trim()) : null;

  // Route: an "A to B" / "A - B" pair, but only when both endpoints look like
  // real place names — the body is full of UI copy ("Manage Bookings", "Add
  // passport…") that a loose matcher would mistake for a route.
  const STOP = /\b(manage|booking|bookings|add|check|head|passport|seat|bag|bags|change|pay|payment|download|print|flight|flights|depart|departs|arrive|arrival|terminal|need|your|our|the|get|save|more|now|click|view|make|where|you|next|steps|details|online|passes|boarding|itinerary|status)\b/i;
  const validPlace = (s?: string) => {
    const w = (s ?? "").trim();
    return w.length >= 2 && w.length <= 22 && /^[A-Z]/.test(w) && !STOP.test(w) && w.split(/\s+/).length <= 3;
  };
  let route: string | null = null;
  // Multi-word both sides so "London - San Francisco" doesn't truncate to "San".
  const place = String.raw`[A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+){0,2}`;
  const toPair = hay.match(new RegExp(String.raw`\b(${place})\s+to\s+(${place})\b`));
  const dash = hay.match(new RegExp(String.raw`\b(${place})\s+[-–]\s+(${place})\b`));
  if (toPair && validPlace(toPair[1]) && validPlace(toPair[2])) route = `${toPair[1]!.trim()} → ${toPair[2]!.trim()}`;
  else if (dash && validPlace(dash[1]) && validPlace(dash[2])) route = `${dash[1]!.trim()} → ${dash[2]!.trim()}`;

  const destRaw = subject.match(new RegExp(String.raw`\b(?:fly|flight|trip)\s+to\s+(${place})`, "i"))?.[1]
    ?? valueAfter(lines, /^destination/i)?.replace(/[:：]/g, "").trim()
    ?? (route ? route.split("→")[1]?.trim() : null);
  const dest = validPlace(destRaw ?? undefined) ? destRaw : null;

  // Departure: prefer an explicit Departs/Departure line, else the first date
  // that isn't a payment / booked-on / bag-drop date.
  let when: { iso: string; hasTime: boolean } | null = null;
  for (const l of lines) {
    if (!/depart/i.test(l)) continue;
    const w = parseWhen(l, now);
    if (w) { when = w; break; }
  }
  if (!when) for (const l of lines) {
    if (/payment|paid|purchased|booked on|order date|placed|fx rate|bag drop|cancellation|issued/i.test(l)) continue;
    const w = parseWhen(l, now);
    if (w) { when = w; break; }
  }

  // Amount: only from an explicit paid/payment/total line. A first-money scan
  // is too noisy here (baggage ads, insurance upsells, FX rates).
  const amount =
    moneyNear(lines, /total paid|card holder|amount paid|you paid|^payment\b/i) ??
    moneyNear(lines, /^(total price|total cost|total)\b/i);
  const passenger = firstName(lines);

  const title = `✈️ ${airline.name}${dest ? ` to ${dest}` : ""}`;
  const fields: Field[] = [];
  if (ref) fields.push({ label: "Booking ref", value: ref, copyable: true });
  if (flights.length) fields.push({ label: flights.length > 1 ? "Flights" : "Flight", value: flights.join(" · "), copyable: false });
  if (route) fields.push({ label: "Route", value: route, copyable: false });
  if (passenger) fields.push({ label: "Passenger", value: passenger, copyable: false });

  const changed = /\b(changed|updated|rebooked|schedule change|amended|new times?)\b/i.test(`${subject} ${body.slice(0, 400)}`);
  const subtitleBits = [route, flights.join(" · ")].filter(Boolean);
  return recordCard({
    board: BOARD.trips, recordKind: "flight", title,
    subtitle: subtitleBits.join(" · ") || null,
    dateLabel: "Departs", date: when?.iso ?? null,
    fields, amount, actionUrl: sourceUrl,
    provider: airline.name,
    status: changed ? "Booking updated" : "Confirmed",
    notice: changed ? "This booking was changed — check the latest times and details." : null,
    brandDomain: brandDomain(airline.name, from),
    sourceUrl, thumb,
  });
}

function extractLodging(
  subject: string, from: string, body: string, sourceUrl: string | null,
  thumb: ParsedInbound["thumb"], now: Date
): ParsedInbound | null {
  const hay = `${from} ${subject} ${body}`.toLowerCase();
  const isBooking = /booking\.com/.test(hay);
  const isAirbnb = /airbnb/.test(hay);
  const isHotelish = /\bcheck[\s-]?in\b/.test(hay) && /\bcheck[\s-]?out\b/.test(hay);
  if (!isBooking && !isAirbnb && !isHotelish) return null;

  const lines = lineList(body);

  // Property name.
  let name =
    subject.match(/confirmed at\s+(.+)$/i)?.[1]?.trim() ??
    subject.match(/reservation at\s+(.+?)\s+for\b/i)?.[1]?.trim() ??
    null;
  if (!name) {
    const rd = lines.findIndex((l) => /^reservation details$/i.test(l));
    if (rd >= 0) name = lines[rd + 1]?.trim() ?? null;
  }
  if (!name) return null;

  const ci = valueAfter(lines, /^check[\s-]?in\b/i);
  const co = valueAfter(lines, /^check[\s-]?out\b/i);
  const ciWhen = parseWhen(ci, now);
  const confirmation = valueAfter(lines, /^confirmation\b/i)?.match(/[A-Z0-9]{5,}/i)?.[0] ?? null;
  const pin = body.match(/\bPIN[:\s]+(\d{3,6})\b/i)?.[1] ?? null;
  // "Your reservation 2 nights, Queen Room" — but NOT the earlier "Your
  // reservation is paid with Booking.com" sentence (would grab boilerplate).
  const reservation = valueAfter(lines, /^your reservation\b(?!\s+is\b)/i);
  const guests = valueAfter(lines, /^(guests|you booked for)\b/i);
  const location = valueAfter(lines, /^location\b/i);
  const phone = valueAfter(lines, /^phone\b/i)?.match(/\+?[\d ()\-]{7,}/)?.[0]?.trim() ?? null;
  // Keep the amount actually paid separate from the quoted price (they may be in
  // different currencies — never combine them), and surface any fee still due at
  // the property. Paid is the headline `amount`.
  const paid = money(valueAfter(lines, /^total (cost|paid)\b/i));
  const quoted = money(valueAfter(lines, /^total price\b/i));
  const amount = paid ?? quoted;
  let dueAtProperty: string | null = null;
  const dueIdx = lines.findIndex((l) => /collected by the property/i.test(l));
  if (dueIdx >= 0) {
    for (let j = dueIdx; j < Math.min(dueIdx + 4, lines.length); j++) {
      const m = money(lines[j]!);
      if (m) { dueAtProperty = m; break; }
    }
  }

  const fields: Field[] = [];
  if (confirmation) fields.push({ label: "Confirmation", value: confirmation, copyable: true });
  if (pin) fields.push({ label: "PIN", value: pin, copyable: true });
  if (ci) fields.push({ label: "Check-in", value: ci.replace(/\s*\(.*$/, "").trim(), copyable: false });
  if (co) fields.push({ label: "Check-out", value: co.replace(/\s*\(.*$/, "").trim(), copyable: false });
  if (reservation) fields.push({ label: "Room", value: reservation, copyable: false });
  if (guests) fields.push({ label: "Guests", value: guests, copyable: false });
  if (quoted && quoted !== amount) fields.push({ label: "Price", value: quoted, copyable: false });
  if (dueAtProperty) fields.push({ label: "Due at property", value: dueAtProperty, copyable: false });
  if (phone) fields.push({ label: "Phone", value: phone, copyable: true });

  const provider = isBooking ? "Booking.com" : isAirbnb ? "Airbnb" : null;
  const nonRefundable = /non[\s-]?refundable/i.test(body);
  const notice = dueAtProperty
    ? `${dueAtProperty} to pay at the property`
    : (nonRefundable ? "Non-refundable booking." : null);
  return recordCard({
    board: BOARD.trips, recordKind: "lodging",
    title: `🏨 ${name}`.slice(0, 200),
    subtitle: [reservation, guests].filter(Boolean).join(" · ") || null,
    dateLabel: "Check-in", date: ciWhen?.iso ?? null,
    fields, amount,
    place: location ? { name, address: location, category: "hotel" } : null,
    actionUrl: sourceUrl,
    provider, status: "Confirmed", notice,
    brandDomain: brandDomain(provider, from),
    sourceUrl, thumb,
  });
}

function extractOrder(
  subject: string, from: string, body: string, sourceUrl: string | null,
  thumb: ParsedInbound["thumb"], now: Date
): ParsedInbound | null {
  const hay = `${subject}\n${body}`;
  const low = `${subject} ${from} ${body.slice(0, 600)}`.toLowerCase();
  const shipped = /shipped|on its way|dispatched|out for delivery|tracking number/.test(low);
  const isOrder = shipped || /\border\s+(number|no\.?|#|confirmation)\b|your order|order date|thanks for your order/.test(low);
  if (!isOrder) return null;

  const lines = lineList(body);
  const merchant = merchantName(from, subject);

  const orderNo =
    subject.match(/\border\s+([A-Z0-9]{5,})/i)?.[1] ??
    valueAfter(lines, /^order\s*(number|no\.?)\b/i)?.match(/[A-Z0-9]{5,}/i)?.[0] ??
    body.match(/\border\s+number\s+is\s+([A-Z0-9]{5,})/i)?.[1] ??
    body.match(/\border\s*(?:number|no\.?|#)\s*[:#]?\s*([A-Z0-9]{5,})/i)?.[1] ??
    null;
  const tracking =
    valueAfter(lines, /tracking number/i)?.match(/[A-Z0-9]{8,}/i)?.[0] ??
    null;

  // Delivery / arrival date preferred (actionable); else order/placed date.
  const deliveryStr =
    valueAfter(lines, /expected delivery date|estimated delivery date|delivery date|expected delivery|estimated delivery|arriving/i) ??
    body.match(/\b(?:in|within)\s+(\d+\s*[-–]\s*\d+\s*(?:working|business)?\s*days?)/i)?.[1] ??
    body.match(/\b(\d+\s*[-–]\s*\d+\s*(?:working|business)?\s*days?)/i)?.[1] ??
    null;
  const orderedStr =
    valueAfter(lines, /order date/i) ??
    body.match(/placed on\s+([0-9/.\-]+)/i)?.[1] ??
    null;
  const delivered = parseWhen(deliveryStr, now);
  const ordered = parseWhen(orderedStr, now);
  const date = delivered ?? ordered;
  const dateLabel = delivered ? "Arrives" : ordered ? "Ordered" : null;

  // First product name: the line just before the first SKU/Ref/Item No. row.
  let product: string | null = null;
  const skuIdx = lines.findIndex((l) => /^(sku|ref|reference|item no\.?)\b/i.test(l));
  if (skuIdx > 0) product = lines[skuIdx - 1]?.trim() ?? null;
  const itemCount = lines.filter((l) => /^(sku|ref|reference|item no\.?)\b/i.test(l)).length;

  const amount = money(
    valueAfter(lines, /^(grand total|order total|total price|total)\b/i) ??
    hay.match(/[£€$]\s?\d[\d,]*(?:\.\d{2})?|\b\d[\d,]*(?:\.\d{2})?\s?(?:GBP|EUR|USD)\b/i)?.[0] ??
    null
  );

  const fields: Field[] = [];
  if (orderNo) fields.push({ label: "Order #", value: orderNo, copyable: true });
  if (tracking) fields.push({ label: "Tracking #", value: tracking, copyable: true });
  if (product) fields.push({ label: "Item", value: product + (itemCount > 1 ? ` +${itemCount - 1} more` : ""), copyable: false });
  // Keep the stated delivery estimate verbatim as a range ("Between 16 and 18
  // Sep", "2–4 working days") — we don't harden a fuzzy window into a hard date.
  if (deliveryStr) fields.push({ label: "Delivery", value: deliveryStr.replace(/\s+/g, " ").trim().slice(0, 60), copyable: false });

  const kind = shipped ? "shipment" : "order";
  const title = `${shipped ? "📦" : "🛍️"} ${merchant} ${shipped ? "shipment" : "order"}`;
  return recordCard({
    board: BOARD.orders, recordKind: kind, title,
    subtitle: product,
    provider: merchant,
    status: shipped ? "Dispatched" : "Order received",
    brandDomain: brandDomain(merchant, from),
    dateLabel, date: date?.iso ?? null,
    fields, amount, actionUrl: sourceUrl, sourceUrl, thumb,
  });
}
