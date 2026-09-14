// Resolve the brand behind a save to a registrable domain, which is enough to
// fetch a logo. The sender's own domain is the most reliable signal (an email
// from orders@newsletter.spacenk.com → spacenk.com); a small override map
// canonicalises a few well-known providers. Pure + unit-tested; the network
// fetch/cache lives in brandLogo.ts.

/** Marketing/transactional subdomains to strip when there's no 2-level TLD. */
const TWO_LEVEL_SLD = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);

/** Registrable domain from a host: "email.ba.com" → "ba.com",
 *  "mail.trainline.co.uk" → "trainline.co.uk". */
export function registrableDomain(host: string): string | null {
  const labels = host.toLowerCase().replace(/^\.+|\.+$/g, "").split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const tld = labels[labels.length - 1]!;
  const sld = labels[labels.length - 2]!;
  if (tld.length === 2 && TWO_LEVEL_SLD.has(sld) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return labels.slice(-2).join(".");
}

function domainFromSender(from: string): string | null {
  const at = from.match(/@([^>\s,;]+)/);
  return at ? registrableDomain(at[1]!) : null;
}

/** Canonical domain for a few brands whose provider name we set explicitly, so a
 *  logo resolves even when the sender domain is unusual or missing. */
const OVERRIDES: [RegExp, string][] = [
  [/british airways|\bba\b/i, "britishairways.com"],
  [/ryanair/i, "ryanair.com"],
  [/easyjet/i, "easyjet.com"],
  [/lufthansa/i, "lufthansa.com"],
  [/booking\.?com/i, "booking.com"],
  [/airbnb/i, "airbnb.com"],
  [/expedia/i, "expedia.com"],
  [/trainline/i, "thetrainline.com"],
  [/eurostar/i, "eurostar.com"],
  [/ticketmaster/i, "ticketmaster.com"],
  [/eventbrite/i, "eventbrite.com"],
  [/\bdice\b/i, "dice.fm"],
  [/amazon/i, "amazon.com"],
  [/space ?nk/i, "spacenk.com"],
  [/tradeinn/i, "tradeinn.com"],
  [/flatspot/i, "flatspot.com"],
];

/** Best-effort brand domain from the provider name and/or original sender. */
export function brandDomain(provider?: string | null, from?: string | null): string | null {
  const p = (provider ?? "").trim();
  if (p) for (const [re, domain] of OVERRIDES) if (re.test(p)) return domain;
  const sender = from ? domainFromSender(from) : null;
  if (sender) return sender;
  // Last resort: a single-word provider like "Flatspot" → flatspot.com.
  const slug = p.toLowerCase().replace(/[^a-z0-9]/g, "");
  return slug.length >= 3 && !p.includes(" ") ? `${slug}.com` : null;
}
