import assert from "node:assert/strict";
import test from "node:test";
import { buildPublicOverview } from "../src/public-overview.js";
import { loadPlaces } from "../src/geo/geocode.js";

test("background overview produces serializable statistics and location pages", async () => {
  const warnings = [1, 2].map(id => ({ id: `report-${id}`, location: "Brezno",
    reportedAt: "2026-10-18T08:00:00Z", lat: 48.805, lng: 19.641 }));
  const snapshot = buildPublicOverview({ warnings, news: [], gz: await loadPlaces(), updatedAt: "2026-10-18T10:00:00Z" });
  assert.equal(snapshot.report.totals.sightings, 2);
  const location = snapshot.locations.find(item => item.slug === "brezno");
  assert.equal(location.path, "/vyskyt-medveda/brezno");
  assert.equal(location.total, 2);
  assert.equal(location.warningItems.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});
