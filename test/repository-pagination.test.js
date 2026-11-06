import assert from "node:assert/strict";
import test from "node:test";
import { loadAllBearReports, loadAllSightings, loadAllNews } from "../src/db/repository.js";

Object.assign(process.env, {
  SUPABASE_URL: "https://pagination-fixture.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test-only-key",
});

for (const [name, read] of [["reports", loadAllBearReports], ["sightings", loadAllSightings], ["news", loadAllNews]]) {
  test(`${name} admin reads paginate beyond the database response cap`, async t => {
    const rows = Array.from({ length: 1205 }, (_, id) => ({ id: String(id), status: "approved" }));
    const requests = [];
    t.mock.method(globalThis, "fetch", async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.equal(url.hostname, "pagination-fixture.supabase.co");
      if (["news_warning_locations", "incident_news_links"].some(table => url.pathname.endsWith("/" + table))) {
        return Response.json([]);
      }
      const offset = Number(url.searchParams.get("offset")) || 0;
      const limit = Number(url.searchParams.get("limit")) || 1000;
      requests.push({ offset, limit, order: url.searchParams.get("order") });
      return Response.json(rows.slice(offset, offset + Math.min(limit, 1000)));
    });
    const result = await read({ limit: 1200 });
    assert.equal(result.length, 1200);
    assert.equal(new Set(result.map(row => row.id)).size, 1200);
    assert.equal(requests[0].offset, 0);
    assert.ok(requests.length > 1);
    assert.ok(requests.every(request => /(?:^|,)id\./.test(request.order)), "Tie dates need a stable ID order");
  });
}

test("all twelve locations survive a batch containing two hundred warning articles", async t => {
  const news = Array.from({ length: 200 }, (_, id) => ({ id: `news-${id}`, payload: {} }));
  const locations = news.flatMap(row => Array.from({ length: 12 }, (_, position) => ({
    news_id: row.id, position, place: `Place ${position}`,
  })));
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.hostname, "pagination-fixture.supabase.co");
    if (url.pathname.endsWith("/news_logs")) return Response.json(news);
    if (url.pathname.endsWith("/news_warning_locations")) {
      const offset = Number(url.searchParams.get("offset")) || 0;
      const limit = Number(url.searchParams.get("limit")) || 1000;
      return Response.json(locations.slice(offset, offset + Math.min(limit, 1000)));
    }
    return Response.json([]);
  });
  const result = await loadAllNews();
  assert.equal(result.length, 200);
  assert.ok(result.every(row => row.locations.length === 12));
});

test("a later database page failure rejects the complete admin read", async t => {
  t.mock.method(globalThis, "fetch", async input => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.hostname, "pagination-fixture.supabase.co");
    if (Number(url.searchParams.get("offset")) > 0) {
      return Response.json({ code: "57014", message: "page timeout" }, { status: 500 });
    }
    return Response.json(Array.from({ length: Number(url.searchParams.get("limit")) }, (_, id) => ({ id })));
  });
  await assert.rejects(loadAllBearReports(), error => error.code === "57014");
});

test("legacy sighting schemas still paginate without the missing status column", async t => {
  const rows = Array.from({ length: 1100 }, (_, id) => ({ id: String(id) }));
  t.mock.method(globalThis, "fetch", async input => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.hostname, "pagination-fixture.supabase.co");
    if (url.searchParams.get("select").split(",").includes("status")) {
      return Response.json({ code: "PGRST204", message: "Missing status column" }, { status: 400 });
    }
    const offset = Number(url.searchParams.get("offset")) || 0;
    const limit = Number(url.searchParams.get("limit")) || 1000;
    return Response.json(rows.slice(offset, offset + Math.min(limit, 1000)));
  });
  assert.equal((await loadAllSightings()).length, 1100);
});
