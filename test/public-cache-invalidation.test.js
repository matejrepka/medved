import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

Object.assign(process.env, {
  SUPABASE_URL: "https://cache-fixture.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test-only-key",
  EMAIL_ENABLED: "false", TELEGRAM_ENABLED: "false", DISABLE_WEBSITE_LOGS: "true",
  DISABLE_STARTUP_REFRESH: "true",
});
const { app, invalidatePublicCaches } = await import("../server.js");

test("public feed errors and invalidation cannot publish an empty or retired successful cache", async t => {
  const realFetch = globalThis.fetch;
  let fail = true, failReports = false, first = true, releaseOld, readStarted;
  const blocked = new Promise(resolve => { releaseOld = resolve; });
  const started = new Promise(resolve => { readStarted = resolve; });
  t.after(releaseOld);
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.hostname, "cache-fixture.supabase.co", "Tests never contact production services");
    if (fail || (failReports && url.pathname.endsWith("/bear_reports"))) {
      return Response.json({ message: "fixture outage" }, { status: 500 });
    }
    if (url.pathname.endsWith("/tumedved_logs")) {
      const old = first;
      first = false;
      if (old) { readStarted(); await blocked; }
      return Response.json([{ id: old ? "old-warning" : "new-warning", source: "tumedved.sk",
        location: old ? "Old location" : "New location", reported_at: "2026-11-05T12:00:00Z",
        scraped_at: "2026-11-06T12:00:00Z", lat: 48.8, lng: 19.6 }]);
    }
    return Response.json([]);
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const get = path => realFetch(`http://127.0.0.1:${server.address().port}${path}`);

  for (const path of ["/api/news", "/api/sightings", "/api/warnings"]) {
    const response = await get(path);
    assert.equal(response.status, 502, path);
    assert.ok((await response.json()).error);
  }
  fail = false;
  invalidatePublicCaches();
  const oldRequest = get("/api/warnings");
  await started;
  invalidatePublicCaches();
  try {
    const response = await get("/api/warnings");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).items[0].location, "New location");
  } finally { releaseOld(); }
  await (await oldRequest).arrayBuffer();
  const cached = await get("/api/warnings");
  assert.equal((await cached.json()).items[0].location, "New location",
    "A late reader cannot overwrite the active warnings cache");
  failReports = true;
  invalidatePublicCaches();
  const partial = await get("/api/warnings");
  assert.equal(partial.status, 502, "Missing community reports cannot become a cached partial feed");
  await partial.arrayBuffer();
});
