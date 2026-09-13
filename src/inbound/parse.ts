// Turn a forwarded email into a Folio card. Travel/booking emails are unusually
// structured: most embed schema.org JSON-LD (FlightReservation, LodgingReservation,
// EventReservation…) — the same markup that powers Gmail's trip cards — and often
// attach a .ics calendar. We parse those first (free, no LLM), then fall back to
// subject/sender heuristics. The board is chosen from the content.

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
}

const BOARD = {
  trips: { boardName: "Trips", boardEmoji: "✈️" },
  events: { boardName: "Events", boardEmoji: "🎫" },
  inbox: { boardName: "Inbox", boardEmoji: "📥" },
} as const;

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

function stripHtml(html?: string): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

// ---- main --------------------------------------------------------------------

export function parseInboundEmail(email: InboundEmail): ParsedInbound {
  const subject = (email.subject ?? "").trim();
  const from = (email.from ?? "").toLowerCase();
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
        extracted: { kind: "link", resolved_url: sourceUrl, kind_detail: "flight", raw: forItem },
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
          : { kind: "link", resolved_url: sourceUrl, kind_detail: "lodging" },
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
          : { kind: "link", resolved_url: sourceUrl, kind_detail: "event" },
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
        extracted: addr ? { kind: "place", name, address: addr, category: "restaurant" } : { kind: "link", resolved_url: sourceUrl },
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
        : { kind: "link", resolved_url: sourceUrl },
      sourceUrl, thumb,
    };
  }

  // 3) Heuristics on subject + sender.
  const hay = `${subject} ${from}`.toLowerCase();
  const isTrip = /(flight|boarding|itinerary|hotel|booking\.com|airbnb|reservation|check-?in|expedia|ryanair|easyjet|british airways|marriott|hilton|train|eurostar|trainline)/.test(hay);
  const isEvent = /(ticket|concert|gig|tour|festival|ticketmaster|dice\.fm|eventbrite|seatgeek|axs\.com|show)/.test(hay);
  const board = isEvent ? BOARD.events : isTrip ? BOARD.trips : BOARD.inbox;
  const emojiPrefix = isEvent ? "🎫 " : isTrip ? "✈️ " : "";

  const snippet = (email.text?.trim() || stripHtml(email.html)).slice(0, 200) || null;
  return {
    ...board, cardType: "link",
    title: (emojiPrefix + (subject || "Forwarded email")).slice(0, 140),
    caption: snippet,
    extracted: { kind: "link", resolved_url: sourceUrl, from },
    sourceUrl, thumb,
  };
}
