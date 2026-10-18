import assert from "node:assert/strict";
import test from "node:test";
import { publishPublicSnapshot, loadPublicSnapshot, snapshotDay } from "../src/db/public-snapshot.js";

test("snapshot publishing stores small per-route documents and explicit feeds", async () => {
  const warning = { id: "report-1", note: "Only the location/feed should download this text" };
  const location = { slug: "brezno", name: "Brezno", warningItems: [warning], newsItems: [] };
  let stored;
  const client = { rpc: async (name, args) => { stored = { name, args }; return { data: true }; } };
  assert.equal(await publishPublicSnapshot(4, "2026-10-18", {
    report: { totals: { sightings: 1 }, allLocations: [location] }, locations: [location],
    warnings: [warning], news: [], updatedAt: "2026-10-18T08:00:00Z",
  }, client), true);
  const payload = stored.args.p_payload;
  assert.equal(payload.stats.report.allLocations, undefined);
  assert.equal(payload.overview.locations[0].warningItems, undefined);
  assert.deepEqual(payload.locations.brezno.warningItems, [warning]);
  assert.deepEqual(payload.warnings.items, [warning]);
  await loadPublicSnapshot({ kind: "location", slug: "brezno", client });
  assert.deepEqual(stored.args, { p_kind: "location", p_slug: "brezno" });
});

test("snapshot day changes at Bratislava midnight including winter time", () => {
  assert.equal(snapshotDay(new Date("2026-10-18T22:01:00Z")), "2026-10-19");
  assert.equal(snapshotDay(new Date("2026-12-18T22:01:00Z")), "2026-12-18");
  assert.equal(snapshotDay(new Date("2026-12-18T23:01:00Z")), "2026-12-19");
});
