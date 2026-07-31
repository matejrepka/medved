import test from "node:test";
import assert from "node:assert/strict";

import {
  mergeNewsLocations,
  newsLocations,
  normalizeNewsLocations,
} from "../src/news-locations.js";

test("warning locations preserve order, prefer coordinates, and remove duplicates", () => {
  const result = normalizeNewsLocations([
    { place: "Važec" },
    { name: " Východná ", lat: 49.06, lng: 19.9 },
    { place: "VAZEC", lat: 49.058, lng: 19.985 },
  ]);

  assert.deepEqual(result.map((location) => location.place), ["Važec", "Východná"]);
  assert.equal(result[0].hasCoords, true);
});

test("legacy warning columns remain a valid single-location fallback", () => {
  assert.deepEqual(newsLocations({ place: "Zvolen", lat: 48.57, lng: 19.12 }), [{
    place: "Zvolen",
    lat: 48.57,
    lng: 19.12,
    hasCoords: true,
  }]);
});

test("missing, zero, and out-of-country coordinates are not map-ready", () => {
  const result = normalizeNewsLocations([
    { place: "Missing", lat: null, lng: null },
    { place: "Gulf of Guinea", lat: 0, lng: 0 },
    { place: "Outside Slovakia", lat: 50.1, lng: 19.1 },
  ]);

  assert.deepEqual(result, [
    { place: "Missing", lat: null, lng: null, hasCoords: false },
    { place: "Gulf of Guinea", lat: null, lng: null, hasCoords: false },
    { place: "Outside Slovakia", lat: null, lng: null, hasCoords: false },
  ]);
});

test("incident listing merges locations from all associated articles", () => {
  const result = mergeNewsLocations([
    { locations: [{ place: "Važec", lat: 49.06, lng: 19.99 }] },
    { locations: [{ place: "Východná", lat: 49.06, lng: 19.9 }, { place: "Važec" }] },
  ]);
  assert.deepEqual(result.map((location) => location.place), ["Važec", "Východná"]);
});
