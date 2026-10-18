import assert from "node:assert/strict";
import test from "node:test";
import { publishPublicSnapshot, loadPublicSnapshot, snapshotDay } from "../src/db/public-snapshot.js";

const stateClient = (readState, rpc) => ({ rpc, from: () => ({ select: () => ({
  eq: () => ({ maybeSingle: async () => ({ data: readState() }) }),
}) }) });

test("snapshot publishing stores small per-route documents and explicit feeds", async () => {
  const warning = { id: "report-1", note: "Only the location/feed should download this text" };
  const location = { slug: "brezno", name: "Brezno", warningItems: [warning], newsItems: [] };
  let stored;
  const client = stateClient(() => ({ revision: 4, built_revision: 4, updated_at: "today" }),
    async (name, args) => { stored = { name, args }; return { data: true }; });
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

test("unchanged revisions reuse documents, changed/invalid revisions retire them and errors retry", async t => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  let revision = 1, built = 1, stateReads = 0, documentReads = 0, fail = false;
  const client = stateClient(() => {
    stateReads++;
    return { revision, built_revision: built, updated_at: `published-${built}` };
  }, async () => {
    documentReads++;
    if (fail) throw new Error("temporary read failure");
    return { data: { revision } };
  });
  const read = () => loadPublicSnapshot({ kind: "news", client });
  const results = await Promise.all([read(), read(), read()]);
  assert.deepEqual(results, [{ revision: 1 }, { revision: 1 }, { revision: 1 }]);
  assert.equal(stateReads, 1);
  assert.equal(documentReads, 1, "Concurrent readers share one document transfer");
  now += 16_000;
  await read();
  assert.equal(stateReads, 2);
  assert.equal(documentReads, 1, "Expired metadata does not redownload an unchanged feed");
  revision = 2;
  now += 16_000;
  assert.equal(await read(), null, "Unpublished revision never reuses the old feed");
  built = 2;
  now += 16_000;
  fail = true;
  await assert.rejects(read(), /temporary/);
  fail = false;
  assert.deepEqual(await read(), { revision: 2 }, "Errors are not cached");
  const secondClient = stateClient(() => ({ revision: 1, built_revision: 1, updated_at: "other" }),
    async () => ({ data: { project: "other" } }));
  assert.deepEqual(await loadPublicSnapshot({ kind: "news", client: secondClient }), { project: "other" });
});

test("snapshot day changes at Bratislava midnight including winter time", () => {
  assert.equal(snapshotDay(new Date("2026-10-18T22:01:00Z")), "2026-10-19");
  assert.equal(snapshotDay(new Date("2026-12-18T22:01:00Z")), "2026-12-18");
  assert.equal(snapshotDay(new Date("2026-12-18T23:01:00Z")), "2026-12-19");
});
