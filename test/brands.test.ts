import { test } from "node:test";
import assert from "node:assert/strict";
import { registrableDomain, brandDomain } from "../src/inbound/brands.js";

test("registrableDomain strips marketing subdomains", () => {
  assert.equal(registrableDomain("email.ba.com"), "ba.com");
  assert.equal(registrableDomain("newsletter.spacenk.com"), "spacenk.com");
  assert.equal(registrableDomain("operational.easyjet.com"), "easyjet.com");
  assert.equal(registrableDomain("crm.ba.com"), "ba.com");
  assert.equal(registrableDomain("news.tradeinn.com"), "tradeinn.com");
});

test("registrableDomain keeps 2-level TLDs", () => {
  assert.equal(registrableDomain("mail.trainline.co.uk"), "trainline.co.uk");
});

test("brandDomain prefers the sender domain", () => {
  assert.equal(brandDomain("Space NK", "Space NK Orders <orders@newsletter.spacenk.com>"), "spacenk.com");
  assert.equal(brandDomain("Tradeinn", "news@tradeinn.com"), "tradeinn.com");
  assert.equal(brandDomain("Flatspot", "orders@flatspot.com"), "flatspot.com");
});

test("brandDomain canonicalises known airlines via the override map", () => {
  assert.equal(brandDomain("British Airways", "BA.e-ticket@email.ba.com"), "britishairways.com");
  assert.equal(brandDomain("Ryanair", "Itinerary@ryanair.com"), "ryanair.com");
  assert.equal(brandDomain("Booking.com", "noreply@booking.com"), "booking.com");
});

test("brandDomain falls back to a single-word provider", () => {
  assert.equal(brandDomain("Flatspot", null), "flatspot.com");
  assert.equal(brandDomain("Some Long Name", null), null); // multi-word, no sender → give up
});
