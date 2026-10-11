import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import "./build-worker.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(await readFile(path.join(root, "wrangler.jsonc"), "utf8"));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
let tileRequests = 0;
let databaseRequests = 0;
const sighting = {
  id: "worker-fixture-sighting",
  source: "tumedved.sk",
  location: "Brezno",
  note: "Integration test sighting",
  lat: 48.805,
  lng: 19.641,
  reported_at: new Date().toISOString(),
  scraped_at: new Date().toISOString(),
  status: "approved",
  url: "https://tumedved.sk/",
};
const fixtures = {
  SUPABASE_URL: "https://fixture.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-only-service-key",
  CARTO_BASEMAPS_API_KEY: "test-only-carto-key",
  ADMIN_PASSWORD: "test-only-admin-password",
  DISABLE_WEBSITE_LOGS: "true",
};

function createRuntime(bindings) {
  // Explicit fixture bindings: never load .env or contact production services.
  return new Miniflare(convertV4MiniflareOptions({
    name: "medved-test",
    modules: true,
    scriptPath: path.join(root, config.main),
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    bindings,
    assets: {
      directory: path.join(root, config.assets.directory),
      binding: config.assets.binding,
      run_worker_first: config.assets.run_worker_first,
      routerConfig: { has_user_worker: true },
      assetConfig: { html_handling: config.assets.html_handling, not_found_handling: config.assets.not_found_handling },
    },
    outboundService(request) {
      const url = new URL(request.url);
      if (url.hostname === "basemaps.cartocdn.com") {
        assert.equal(url.searchParams.get("key"), fixtures.CARTO_BASEMAPS_API_KEY);
        tileRequests++;
        return new Response(png, { headers: { "content-type": "image/png" } });
      }
      if (url.hostname === "fixture.supabase.co") {
        databaseRequests++;
        assert.equal(request.headers.get("apikey"), fixtures.SUPABASE_SERVICE_ROLE_KEY);
        return Response.json(url.pathname.endsWith("/tumedved_logs") ? [sighting] : []);
      }
      if (url.hostname === "nominatim.openstreetmap.org") return Response.json([]);
      throw new Error(`Unexpected outbound request: ${url.hostname}`);
    },
  }));
}

const runtime = createRuntime(fixtures);
try {
  const get = (pathname, init = {}) => runtime.dispatchFetch(`https://www.kdejemedved.sk${pathname}`, {
    ...init, headers: { "accept-encoding": "identity", ...init.headers },
  });
  let response = await get("/api/status");
  assert.equal(response.status, 200, await response.text());
  for (const route of ["/api/sightings", "/api/warnings", "/api/news"]) {
    response = await get(route);
    assert.equal(response.status, 200, route);
    const data = await response.json();
    assert.ok(Array.isArray(data.items), route);
    if (route !== "/api/news") assert.equal(data.items[0].location, "Brezno", "Stored sightings reach the map API");
  }
  assert.ok(databaseRequests > 0, "Runtime bindings reach the Supabase client");
  response = await get("/api/map-tiles/dark_all/0/0/0.png");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal(tileRequests, 1);
  response = await get("/api/map-tiles/dark_all/0/1/0.png");
  assert.equal(response.status, 400);
  assert.equal(tileRequests, 1, "Invalid tile coordinates never contact CARTO");

  for (const route of ["/", "/spravy", "/varovania", "/admin", "/stats", "/nahlas"]) {
    response = await get(route);
    assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
    const html = await response.text();
    assert.match(html, /<!doctype html>/i, route);
    assert.ok(!html.includes("<!-- SEO_HEAD -->"), `${route} is rendered`);
  }
  for (const route of ["/app.js", "/styles.css", "/vendor/leaflet/leaflet.js", "/vendor/leaflet/leaflet.css", "/vendor/fonts/hanken/files/hanken-grotesk-latin-wght-normal.woff2", "/vendor/chart/chart.umd.js", "/vendor/phosphor/regular/Phosphor.woff2"]) {
    response = await get(route);
    assert.equal(response.status, 200, route);
    assert.ok((await response.arrayBuffer()).byteLength > 0, route);
  }
  response = await get("/not-a-page", { headers: { accept: "text/html" } });
  assert.equal(response.status, 404);
  assert.match(await response.text(), /<!doctype html>/i);
  response = await get("/api/admin/pending");
  assert.equal(response.status, 401, "Admin authentication is enforced");
  response = await get("/api/admin/locations?q=Brezno", {
    headers: { authorization: `Basic ${Buffer.from(`admin:${fixtures.ADMIN_PASSWORD}`).toString("base64")}` },
  });
  assert.equal(response.status, 200, "Offline location gazetteer is bundled");
  assert.match(await response.text(), /Brezno/);
  const worker = await runtime.getWorker("medved-test");
  await worker.scheduled({ cron: "*/5 * * * *" });
  console.log("Workers checks passed: API, runtime secrets, tiles, SSR, assets, admin authentication and gazetteer");
} finally {
  await runtime.dispose();
}

const unconfigured = createRuntime({ DISABLE_WEBSITE_LOGS: "true" });
try {
  const response = await unconfigured.dispatchFetch("https://www.kdejemedved.sk/api/map-tiles/dark_all/0/0/0.png");
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "Map tiles are not configured");
  console.log("Workers check passed: missing tile secret gives an explicit 503 instead of a routing 404");
} finally {
  await unconfigured.dispose();
}
