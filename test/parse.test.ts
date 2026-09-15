// Fixture-driven tests for the forwarded-email parser, using real emails saved
// under samples/. Each fixture begins with the original From:/Subject:/Date:
// header block (as Apple Mail includes when forwarding), so we simulate a
// forward: envelope from = the user, subject = "Fwd: …", body = the whole dump.
// `unwrapForwarded` then recovers the true sender + subject for detection.
//
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseInboundEmail, type InboundEmail } from "../src/inbound/parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const samplesDir = join(here, "..", "samples");

/** Pull the original Subject:/Date: out of a fixture's header block. */
function headerBlock(raw: string): { subject: string; date: Date } {
  const subject = raw.match(/^Subject:\s*(.+)$/mi)?.[1]?.trim() ?? "";
  const dateStr = raw.match(/^Date:\s*(.+)$/mi)?.[1]?.trim() ?? "";
  const parsed = Date.parse(dateStr.replace(/\bat\b/i, ""));
  return { subject, date: Number.isNaN(parsed) ? new Date("2026-06-01T00:00:00Z") : new Date(parsed) };
}

function parseFixture(file: string) {
  const raw = readFileSync(join(samplesDir, file), "utf8");
  const { subject, date } = headerBlock(raw);
  const email: InboundEmail = {
    to: "alex-abc123@folioinbox.me",
    from: "Alex Morris <alex@thedoidea.co>", // the forwarder
    subject: `Fwd: ${subject}`,
    text: raw,
  };
  return parseInboundEmail(email, { now: date });
}

function record(p: ReturnType<typeof parseFixture>) {
  assert.equal(p.extracted.kind, "record", `${p.title}: expected a .record extract`);
  return p.extracted as any;
}

const field = (r: any, label: string) =>
  (r.fields ?? []).find((f: any) => f.label.toLowerCase() === label.toLowerCase())?.value ?? null;

// ---- Flights ---------------------------------------------------------------

test("BA changed e-ticket → flight ZXRQ9T", () => {
  const p = parseFixture("ba-changed-zxrq9t.txt");
  const r = record(p);
  assert.equal(r.record_kind, "flight");
  assert.equal(r.board_kind ?? p.boardName, "Trips");
  assert.equal(field(r, "Booking ref"), "ZXRQ9T");
  assert.match(field(r, "Flight") ?? field(r, "Flights") ?? "", /BA\d{3,4}/);
  assert.ok(r.date?.startsWith("2026-02-21"), `date was ${r.date}`);
  assert.equal(p.eventAt, r.date);
  assert.equal(r.provider, "British Airways");
  assert.equal(r.status, "Booking updated"); // subject says "changed"
  assert.ok(r.notice, "expected a change notice");
});

test("BA booking confirmation → flight XP3LKK", () => {
  const p = parseFixture("ba-confirm-xp3lkk.txt");
  const r = record(p);
  assert.equal(r.record_kind, "flight");
  assert.equal(field(r, "Booking ref"), "XP3LKK");
  assert.ok(r.date?.startsWith("2025-12-13"), `date was ${r.date}`);
  // Multi-word destination must not truncate ("San Francisco", never "San").
  assert.match(r.title, /San Francisco/);
  assert.doesNotMatch(r.title, /to San$/);
});

test("Ryanair itinerary → flight Y1H4RC", () => {
  const p = parseFixture("ryanair-y1h4rc.txt");
  const r = record(p);
  assert.equal(r.record_kind, "flight");
  assert.equal(field(r, "Booking ref"), "Y1H4RC");
  assert.match(field(r, "Flight") ?? field(r, "Flights") ?? "", /FR4950/);
  assert.ok(r.date?.startsWith("2026-08-03"), `date was ${r.date}`);
  assert.equal(r.amount, "£204.69");
});

test("Ryanair older itinerary → flight TP4NXR", () => {
  const p = parseFixture("ryanair-tp4nxr.txt");
  const r = record(p);
  assert.equal(field(r, "Booking ref"), "TP4NXR");
  assert.ok(r.date?.startsWith("2018-06-14"), `date was ${r.date}`);
});

test("easyJet reminder (year-less date) → flight KCPV1PS", () => {
  const p = parseFixture("easyjet-kcpv1ps.txt");
  const r = record(p);
  assert.equal(r.record_kind, "flight");
  assert.equal(field(r, "Booking ref"), "KCPV1PS");
  assert.ok(r.date?.startsWith("2026-06-26"), `date was ${r.date}`);
});

test("easyJet booking reference → flight KCTT39R", () => {
  const p = parseFixture("easyjet-kctt39r.txt");
  const r = record(p);
  assert.equal(field(r, "Booking ref"), "KCTT39R");
  assert.ok(r.date?.startsWith("2026-06-29"), `date was ${r.date}`);
  assert.equal(r.amount, "€186.30");
});

// ---- Lodging ---------------------------------------------------------------

test("Booking.com Moxy Dublin → lodging", () => {
  const p = parseFixture("booking-moxy-dublin.txt");
  const r = record(p);
  assert.equal(r.record_kind, "lodging");
  assert.match(r.title, /Moxy Dublin City/);
  assert.equal(field(r, "Confirmation"), "5833740861");
  assert.equal(field(r, "PIN"), "4219");
  assert.ok(r.date?.startsWith("2026-07-15"), `date was ${r.date}`);
  assert.equal(r.amount, "£391.85");
  assert.ok(r.place?.address?.includes("Sackville"), `address was ${r.place?.address}`);
});

test("Booking.com citizenM Paris (am/pm) → lodging", () => {
  const p = parseFixture("booking-citizenm-paris.txt");
  const r = record(p);
  assert.equal(r.record_kind, "lodging");
  assert.match(r.title, /citizenM Paris/);
  assert.equal(field(r, "Confirmation"), "5660114154");
  assert.ok(r.date?.startsWith("2026-06-03"), `date was ${r.date}`);
});

test("Airbnb Madeleine (split weekday/date) → lodging", () => {
  const p = parseFixture("airbnb-madeleine.txt");
  const r = record(p);
  assert.equal(r.record_kind, "lodging");
  assert.match(r.title, /Madeleine Skyline/);
  assert.ok(r.date?.startsWith("2023-02-17"), `date was ${r.date}`);
});

test("Airbnb South Downs → lodging", () => {
  const p = parseFixture("airbnb-southdowns.txt");
  const r = record(p);
  assert.match(r.title, /South Downs/);
  assert.ok(r.date?.startsWith("2023-07-22"), `date was ${r.date}`);
});

// ---- Orders / shipments ----------------------------------------------------

test("Flatspot order → order F1020224", () => {
  const p = parseFixture("flatspot-f1020224.txt");
  const r = record(p);
  assert.equal(r.record_kind, "order");
  assert.equal(p.boardName, "Orders");
  assert.equal(field(r, "Order #"), "F1020224");
  assert.equal(r.amount, "£67.00");
  assert.ok(r.date?.startsWith("2026-09-08"), `date was ${r.date}`);
});

test("Space NK shipment → shipment WK34708259", () => {
  const p = parseFixture("spacenk-wk34708259.txt");
  const r = record(p);
  assert.equal(r.record_kind, "shipment");
  assert.equal(field(r, "Order #"), "WK34708259");
  assert.equal(field(r, "Tracking #"), "XJ223546789GB");
});

test("Tradeinn shipment (delivery window) → shipment 72423796", () => {
  const p = parseFixture("tradeinn-72423796.txt");
  const r = record(p);
  assert.equal(r.record_kind, "shipment");
  assert.equal(field(r, "Order #"), "72423796");
  assert.ok(r.date?.startsWith("2026-09-16"), `date was ${r.date}`);
  assert.equal(r.amount, "£97.99");
  assert.match(field(r, "Delivery") ?? "", /16.*Sep.*18.*Sep/i);
});

// ---- Money: quoted vs paid preserved separately (never summed) -------------

test("citizenM keeps quoted price + amount due at property", () => {
  const r = record(parseFixture("booking-citizenm-paris.txt"));
  assert.equal(r.amount, "€301");                       // paid is the headline
  assert.equal(field(r, "Price"), "€317.90");           // quoted, shown separately
  assert.equal(field(r, "Due at property"), "€16.90");  // city tax still owed
});

test("Moxy keeps GBP paid + EUR quoted separately (no cross-currency math)", () => {
  const r = record(parseFixture("booking-moxy-dublin.txt"));
  assert.equal(r.amount, "£391.85");
  assert.equal(field(r, "Price"), "€453.90");
});

test("Space NK keeps '2–4 working days' as a relative window, no hard date", () => {
  const r = record(parseFixture("spacenk-wk34708259.txt"));
  assert.equal(r.date ?? null, null, `should have no hard date, got ${r.date}`);
  assert.match(field(r, "Delivery") ?? "", /2\s*[-–]\s*4\s*working days/i);
});

// ---- HTML-only path (de-risks real MIME, which is HTML not plain text) -----
//
// Real forwarded mail is HTML MIME; the RTF exports gave us rendered text. To
// prove the line-based extractors survive when only `html` is present, wrap each
// source line in a <div>/table cell and re-extract with no `text` part.

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function asHtml(file: string): { subject: string; html: string; date: Date } {
  const raw = readFileSync(join(samplesDir, file), "utf8");
  const { subject, date } = headerBlock(raw);
  // Alternate plain <div>s and one-cell-per-row tables to mimic real templates.
  const html = raw.split(/\r?\n/).map((l, i) =>
    i % 3 === 0
      ? `<table><tr><td>${esc(l)}</td></tr></table>`
      : `<div>${esc(l)}</div>`
  ).join("");
  return { subject, html, date };
}
function parseHtmlFixture(file: string) {
  const { subject, html, date } = asHtml(file);
  return parseInboundEmail(
    { to: "alex-abc@folioinbox.me", from: "Alex <alex@thedoidea.co>", subject: `Fwd: ${subject}`, html },
    { now: date }
  );
}

test("HTML-only Booking.com email still extracts the lodging record", () => {
  const p = parseHtmlFixture("booking-moxy-dublin.txt");
  const r = record(p);
  assert.equal(r.record_kind, "lodging");
  assert.match(r.title, /Moxy Dublin City/);
  assert.equal(field(r, "Confirmation"), "5833740861");
  assert.ok(r.date?.startsWith("2026-07-15"), `date was ${r.date}`);
});

test("HTML-only Ryanair email still extracts the flight record", () => {
  const p = parseHtmlFixture("ryanair-y1h4rc.txt");
  const r = record(p);
  assert.equal(r.record_kind, "flight");
  assert.equal(field(r, "Booking ref"), "Y1H4RC");
  assert.ok(r.date?.startsWith("2026-08-03"), `date was ${r.date}`);
});

// ---- Events + trains --------------------------------------------------------

test("Ticketmaster concert → event record (HAIM)", () => {
  const p = parseFixture("ticketmaster-haim.txt");
  const r = record(p);
  assert.equal(r.record_kind, "event");
  assert.equal(p.boardName, "Events");
  assert.equal(r.provider, "Ticketmaster");
  assert.match(r.title, /HAIM/);
  assert.equal(field(r, "Order #"), "8-13232/UK1");
  assert.ok(r.date?.startsWith("2025-10-28"), `date was ${r.date}`);
  assert.match(field(r, "Venue") ?? "", /O2/);
  assert.equal(r.amount, "£282.75");
});

test("Eurostar → train record (Y6FRGP)", () => {
  const p = parseFixture("eurostar-y6frgp.txt");
  const r = record(p);
  assert.equal(r.record_kind, "trip");
  assert.equal(p.boardName, "Trips");
  assert.equal(r.provider, "Eurostar");
  assert.equal(field(r, "Booking ref"), "Y6FRGP");
  assert.match(field(r, "Route") ?? "", /Paris.*→.*London/);
  assert.ok(r.date?.startsWith("2026-07-02"), `date was ${r.date}`);
  assert.match(field(r, "Seat") ?? "", /Coach 15/);
});

test("Trainline return trip → train record (Cardiff↔London)", () => {
  const p = parseFixture("trainline-cardiff.txt");
  const r = record(p);
  assert.equal(r.record_kind, "trip");
  assert.equal(r.provider, "Trainline");
  assert.match(field(r, "Route") ?? "", /Cardiff.*→.*London/);
  assert.ok(r.date?.startsWith("2026-06-17"), `date was ${r.date}`);
  assert.equal(r.amount, "£239.59");
});

// ---- Quote-style forwards ("> " on every line) -----------------------------

test("quote-forwarded Booking.com email still extracts check-in/confirmation", () => {
  const raw = readFileSync(join(samplesDir, "booking-moxy-dublin.txt"), "utf8");
  const quoted = raw.split(/\r?\n/).map((l) => `> ${l}`).join("\n");
  const p = parseInboundEmail(
    { to: "x@folioinbox.me", from: "Alex <alex@me.com>", subject: "Fwd: 🛄 Thanks! Your booking is confirmed at Moxy Dublin City", text: quoted },
    { now: new Date("2026-06-29") }
  );
  const r = record(p);
  assert.equal(r.record_kind, "lodging");
  assert.equal(field(r, "Confirmation"), "5833740861"); // from a quoted body line
  assert.equal(field(r, "PIN"), "4219");
  assert.ok(r.date?.startsWith("2026-07-15"), `date was ${r.date}`);
});

// ---- Real MIME (decoded exactly as postal-mime hands it to the endpoint) ----
//
// From a genuine forwarded .eml (base64 multipart/alternative). Crucially the
// real text/plain uses inline "Label value" rows with no colon — the shape the
// RTF exports never showed us. Both the real text and the real 91KB HTML must
// yield the same lodging record.

const realNow = new Date("2026-06-29T14:29:16+02:00"); // the message's own Date

test("real Booking.com .eml (text/plain part) extracts the full lodging record", () => {
  const text = readFileSync(join(samplesDir, "real-moxy-dublin.plain.txt"), "utf8");
  const p = parseInboundEmail(
    { to: "alex-abc@folioinbox.me", from: "noreply@booking.com",
      subject: "🛄 Thanks! Your booking is confirmed at Moxy Dublin City", text },
    { now: realNow }
  );
  const r = record(p);
  assert.equal(r.record_kind, "lodging");
  assert.match(r.title, /Moxy Dublin City/);
  assert.equal(field(r, "Confirmation"), "5833740861");
  assert.equal(field(r, "PIN"), "4219");
  assert.equal(field(r, "Check-in"), "Wednesday, 15 July 2026"); // inline, no colon, time stripped
  assert.equal(field(r, "Room"), "2 nights, Queen Room");        // not the "is paid" boilerplate
  assert.equal(field(r, "Guests"), "2 adults");
  assert.ok(r.date?.startsWith("2026-07-15"), `date was ${r.date}`);
  assert.equal(r.amount, "£391.85");
  assert.equal(field(r, "Price"), "€453.90");
  assert.equal(r.provider, "Booking.com");
  assert.equal(r.status, "Confirmed");
  assert.ok(r.place?.address?.includes("Sackville"), `address was ${r.place?.address}`);
});

test("citizenM notice = city tax due at property", () => {
  const r = record(parseFixture("booking-citizenm-paris.txt"));
  assert.match(r.notice ?? "", /16\.90.*property/i);
});

test("Tradeinn provider + Dispatched status", () => {
  const r = record(parseFixture("tradeinn-72423796.txt"));
  assert.equal(r.provider, "Tradeinn");
  assert.equal(r.status, "Dispatched");
});

test("real Booking.com .eml (91KB text/html part) also extracts the record", () => {
  const html = readFileSync(join(samplesDir, "real-moxy-dublin.html"), "utf8");
  const p = parseInboundEmail(
    { to: "alex-abc@folioinbox.me", from: "noreply@booking.com",
      subject: "🛄 Thanks! Your booking is confirmed at Moxy Dublin City", html },
    { now: realNow }
  );
  const r = record(p);
  assert.equal(r.record_kind, "lodging");
  assert.equal(field(r, "Confirmation"), "5833740861");
  assert.ok(r.date?.startsWith("2026-07-15"), `date was ${r.date}`);
});
