// Unit tests for the music mapper (pure, no network). Mirrors an iTunes Search
// API song result.
//
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { musicFromItunes } from "../src/extraction.js";

const ITUNES_SONG = {
  wrapperType: "track",
  kind: "song",
  trackId: 1499378615,
  artistName: "The Weeknd",
  collectionName: "After Hours",
  trackName: "Blinding Lights",
  trackViewUrl: "https://music.apple.com/gb/album/blinding-lights/1499378108?i=1499378615",
  previewUrl: "https://audio-ssl.itunes.apple.com/preview.m4a",
  artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/Music/x/100x100bb.jpg",
  trackTimeMillis: 200040,
};

test("musicFromItunes maps a Spotify save: keeps Spotify link, adds Apple Music", () => {
  const m = musicFromItunes(ITUNES_SONG, {
    sourceUrl: "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b",
    sourcePlatform: "spotify", kindDetail: "song",
  }) as any;
  assert.equal(m.kind, "music");
  assert.equal(m.kind_detail, "song");
  assert.equal(m.title, "Blinding Lights");
  assert.equal(m.artist, "The Weeknd");
  assert.equal(m.album, "After Hours");
  assert.equal(m.duration_sec, 200);          // 200040ms → 200s
  assert.equal(m.apple_music_id, "1499378615");
  assert.equal(m.preview_url, "https://audio-ssl.itunes.apple.com/preview.m4a");
  // Artwork upscaled to 600×600.
  assert.match(m.artwork_url, /600x600bb\.jpg$/);
  // Both service links present, source first.
  assert.equal(m.links.length, 2);
  assert.deepEqual(m.links[0], { platform: "spotify", url: "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b" });
  assert.equal(m.links[1].platform, "appleMusic");
  assert.match(m.links[1].url, /music\.apple\.com/);
});

test("musicFromItunes for an Apple Music save doesn't duplicate the link", () => {
  const url = "https://music.apple.com/gb/album/blinding-lights/1499378108?i=1499378615";
  const m = musicFromItunes(ITUNES_SONG, { sourceUrl: url, sourcePlatform: "appleMusic", kindDetail: "song" }) as any;
  assert.equal(m.links.length, 1);
  assert.deepEqual(m.links[0], { platform: "appleMusic", url });
});

test("musicFromItunes on a collection (album) result", () => {
  const album = { wrapperType: "collection", collectionType: "Album", collectionId: 1499378108,
    artistName: "The Weeknd", collectionName: "After Hours",
    collectionViewUrl: "https://music.apple.com/gb/album/after-hours/1499378108",
    artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/Music/x/100x100bb.jpg", trackCount: 14 };
  const m = musicFromItunes(album, { sourceUrl: "https://open.spotify.com/album/x", sourcePlatform: "spotify", kindDetail: "album" }) as any;
  assert.equal(m.title, "After Hours");
  assert.equal(m.track_count, 14);
  assert.equal(m.preview_url, null);
  assert.equal(m.apple_music_id, "1499378108");
});

test("musicFromItunes returns null on empty input", () => {
  assert.equal(musicFromItunes(null, { sourceUrl: "x", sourcePlatform: "spotify", kindDetail: "song" }), null);
});
