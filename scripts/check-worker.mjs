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
const rotated = {
  ...fixtures,
  CARTO_BASEMAPS_API_KEY: "test-only-rotated-carto-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-only-rotated-service-key",
};
const seenMapKeys = new Set();
const seenDatabaseKeys = new Set();
const script = await readFile(path.join(root, config.main), "utf8");

function createRuntime(bindings, simulateUpdates = false) {
  // Explicit fixture bindings: never load .env or contact production services.
  return new Miniflare(convertV4MiniflareOptions({
    name: "medved-test",
    ...(simulateUpdates ? {
      // Test-only wrapper varies handler bindings without reloading the module,
      // reproducing Cloudflare's isolate reuse after a secret-only deployment.
      modules: [{
        type: "ESModule", path: path.join(root, "fixture-entry.js"),
        contents: `import worker from './fixture-app.js';
          let calls = 0;
          const variants = ${JSON.stringify({ added: fixtures, rotated })};
          export default { ...worker, async fetch(request, env, ctx) {
            const update = variants[new URL(request.url).searchParams.get('fixtureBindings')];
            const response = await worker.fetch(request, update ? {...env, ...update} : env, ctx);
            const result = new Response(response.body, response);
            result.headers.set('x-fixture-calls', String(++calls));
            return result;
          }};`,
      }, { type: "ESModule", path: path.join(root, "fixture-app.js"), contents: script }],
    } : { modules: true, scriptPath: path.join(root, config.main) }),
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
        const key = url.searchParams.get("key");
        assert.ok([fixtures.CARTO_BASEMAPS_API_KEY, rotated.CARTO_BASEMAPS_API_KEY].includes(key));
        seenMapKeys.add(key);
        tileRequests++;
        return new Response(png, { headers: { "content-type": "image/png" } });
      }
      if (url.hostname === "fixture.supabase.co") {
        databaseRequests++;
        const key = request.headers.get("apikey");
        assert.ok([fixtures.SUPABASE_SERVICE_ROLE_KEY, rotated.SUPABASE_SERVICE_ROLE_KEY].includes(key));
        seenDatabaseKeys.add(key);
        return Response.json(url.pathname.endsWith("/tumedved_logs") ? [sighting] : []);
      }
      if (url.hostname === "nominatim.openstreetmap.org") return Response.json([]);
      if (url.hostname === "overpass-api.de") return Response.json({ elements: [] });
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
  response = await get("/api/admin/locations?q=" + encodeURIComponent("Kláštorská cesta v Slovenskom raji"), {
    headers: { authorization: `Basic ${Buffer.from(`admin:${fixtures.ADMIN_PASSWORD}`).toString("base64")}` },
  });
  assert.equal(response.status, 200, "Tourist aliases and coordinates are bundled in Workers");
  const tourist = (await response.json()).results[0];
  assert.equal(tourist.name, "Kláštorská cesta");
  assert.equal(tourist.lat, 48.9526744);
  assert.equal(tourist.lng, 20.3988546);
  assert.match(tourist.label, /orientačný bod na trase/);
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

const changing = createRuntime({ DISABLE_WEBSITE_LOGS: "true" }, true);
try {
  const get = (route, variant = "", headers = {}) => changing.dispatchFetch(
    `https://www.kdejemedved.sk${route}?fixtureBindings=${variant}`,
    { headers: { "accept-encoding": "identity", ...headers } },
  );
  let response = await get("/api/map-tiles/dark_all/0/0/0.png");
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("x-fixture-calls"), "1");
  for (const [index, variant] of ["added", "rotated"].entries()) {
    response = await get("/api/map-tiles/dark_all/0/0/0.png", variant);
    assert.equal(response.status, 200, `Map key ${variant} is read from this request's bindings`);
    assert.equal(response.headers.get("x-fixture-calls"), String(index * 2 + 2), "Same module instance is retained");
    await response.arrayBuffer();
    response = await get("/api/admin/pending", variant, {
      authorization: `Basic ${Buffer.from(`admin:${fixtures.ADMIN_PASSWORD}`).toString("base64")}`,
    });
    assert.equal(response.status, 200, `Database key ${variant} is read from this request's bindings`);
    await response.arrayBuffer();
  }
  assert.ok(seenMapKeys.has(rotated.CARTO_BASEMAPS_API_KEY));
  assert.ok(seenDatabaseKeys.has(rotated.SUPABASE_SERVICE_ROLE_KEY));
  response = await get("/api/status", "added");
  const status = await response.json();
  assert.equal(status.mapTilesConfigured, true);
  assert.equal(status.supabaseConfigured, true);
  response = await get("/api/status");
  const missingStatus = await response.json();
  assert.equal(missingStatus.mapTilesConfigured, false, "Removed bindings are not retained");
  assert.equal(missingStatus.supabaseConfigured, false);
  console.log("Workers checks passed: adding, rotating and removing secrets on the same module instance");
} finally {
  await changing.dispose();
}
