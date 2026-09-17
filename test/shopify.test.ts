// Unit tests for the Shopify product mapper (pure, no network). Mirrors the
// `/products/<handle>.js` AJAX payload real stores return.
//
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { shopifyJsonToProduct } from "../src/extraction.js";

const ORIGIN = "https://store.com";
const URL = "https://store.com/products/classic-tee";

// A realistic product.js: prices in cents, per-variant availability, two options,
// protocol-relative CDN images.
const PRODUCT_JS = {
  id: 123,
  title: "Classic Tee",
  handle: "classic-tee",
  description: "<p>Soft <b>cotton</b> tee.</p>",
  vendor: "Acme",
  price: 2000,
  price_min: 2000,
  compare_at_price: 3000,
  compare_at_price_max: 3000,
  available: true,
  options: [
    { name: "Size", position: 1, values: ["S", "M", "L"] },
    { name: "Colour", position: 2, values: ["Red", "Blue"] },
  ],
  variants: [
    { id: 111, title: "S / Red", option1: "S", option2: "Red", price: 2000, compare_at_price: 3000, available: false, options: ["S", "Red"] },
    { id: 222, title: "M / Blue", option1: "M", option2: "Blue", price: 2000, compare_at_price: 3000, available: true, options: ["M", "Blue"] },
  ],
  images: ["//cdn.shopify.com/s/files/1/img1.jpg", "//cdn.shopify.com/s/files/1/img2.jpg"],
  featured_image: "//cdn.shopify.com/s/files/1/img1.jpg",
};

test("shopifyJsonToProduct maps price, sale, availability, variants, images", () => {
  const p = shopifyJsonToProduct(PRODUCT_JS, ORIGIN, URL, "GBP") as any;
  assert.equal(p.kind, "product");
  assert.equal(p.title, "Classic Tee");
  assert.equal(p.description, "Soft cotton tee.");
  assert.equal(p.vendor, "Acme");
  assert.equal(p.shop_domain, "store.com");
  assert.equal(p.product_url, URL);
  assert.equal(p.price, "£20.00");           // 2000 cents
  assert.equal(p.compare_at_price, "£30.00"); // on sale
  assert.equal(p.available, true);            // M/Blue is available
  assert.equal(p.variants.length, 2);
  assert.equal(p.variants[0].id, "111");
  assert.equal(p.variants[0].available, false);
  assert.equal(p.variants[1].id, "222");      // used for /cart/222:1
  assert.equal(p.variants[1].available, true);
  assert.equal(p.options.length, 2);
  assert.deepEqual(p.options[0], { name: "Size", values: ["S", "M", "L"] });
  // Protocol-relative CDN images are absolutized to https.
  assert.equal(p.image, "https://cdn.shopify.com/s/files/1/img1.jpg");
  assert.equal(p.images.length, 2);
  assert.ok(p.images.every((u: string) => u.startsWith("https://")));
});

test("string-form options derive their values from the variants", () => {
  const js = {
    ...PRODUCT_JS,
    options: ["Size", "Colour"], // some themes serialize options as bare names
  };
  const p = shopifyJsonToProduct(js, ORIGIN, URL, "GBP") as any;
  assert.deepEqual(p.options[0], { name: "Size", values: ["S", "M"] });
  assert.deepEqual(p.options[1], { name: "Colour", values: ["Red", "Blue"] });
});

test("no compare-at ⇒ no strike-through; sold out ⇒ available false", () => {
  const js = {
    ...PRODUCT_JS,
    compare_at_price: null,
    compare_at_price_max: null,
    available: false,
    variants: PRODUCT_JS.variants.map((v) => ({ ...v, available: false, compare_at_price: null })),
  };
  const p = shopifyJsonToProduct(js, ORIGIN, URL, "GBP") as any;
  assert.equal(p.compare_at_price, null);
  assert.equal(p.available, false);
});

test("non-Shopify payload (no variants) returns null", () => {
  assert.equal(shopifyJsonToProduct({ title: "x" }, ORIGIN, URL), null);
  assert.equal(shopifyJsonToProduct(null, ORIGIN, URL), null);
});

test("missing currency ⇒ bare numeric price (no wrong symbol)", () => {
  const p = shopifyJsonToProduct(PRODUCT_JS, ORIGIN, URL) as any;
  assert.equal(p.price, "20.00");
  assert.equal(p.currency, null);
});
