// Unit tests for title normalisation + URL-slug fallback — the fix for pages
// (e.g. Zara Home) whose og:title is a blank `&nbsp;`, which produced a
// content-less card.
//
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { tidyTitle, titleFromURL } from "../src/extraction.js";

test("tidyTitle rejects blank / whitespace / nbsp titles", () => {
  assert.equal(tidyTitle(undefined), undefined);
  assert.equal(tidyTitle("   "), undefined);
  assert.equal(tidyTitle(" "), undefined);          // decoded nbsp
  assert.equal(tidyTitle("a"), undefined);               // too short
  assert.equal(tidyTitle("  Folding Chair  "), "Folding Chair");
});

test("titleFromURL humanises the slug and drops the product code", () => {
  assert.equal(
    titleFromURL("https://www.zarahome.com/gb/folding-corduroy-chair-l48336073"),
    "Folding Corduroy Chair"
  );
  assert.equal(
    titleFromURL("https://shop.com/products/oak-side-table"),
    "Oak Side Table"
  );
  // No usable slug → undefined (caller falls back to the host).
  assert.equal(titleFromURL("https://example.com/"), undefined);
  assert.equal(titleFromURL("https://example.com/12345"), undefined);
});
