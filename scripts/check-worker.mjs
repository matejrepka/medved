import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import "./build-worker.mjs";
import { buildPublicOverview } from "../src/public-overview.js";
import { loadPlaces } from "../src/geo/geocode.js";

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
const storedSnapshot = buildPublicOverview({
  warnings: [1, 2].map(id => ({ id: `snapshot-${id}`, location: "Brezno", note: "Saved fixture",
    reportedAt: sighting.reported_at, lat: sighting.lat, lng: sighting.lng })),
  news: [], gz: await loadPlaces(), updatedAt: "2026-10-18T10:00:00Z",
});
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

function createRuntime(bindings, simulateUpdates = false, dataset = null) {
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
        const table = url.pathname.split("/").at(-1);
        if (table === "public_snapshots") return Response.json({
          revision: dataset?.revision || 1,
          built_revision: dataset?.public_snapshot === null ? null : dataset?.revision || 1,
          updated_at: storedSnapshot.updatedAt,
        });
        if (url.pathname.includes("/rpc/")) {
          assert.equal(table, "read_public_snapshot", "Public requests never run computation or publish RPCs");
          if (dataset && Object.hasOwn(dataset, "public_snapshot")) return Response.json(dataset.public_snapshot);
          return request.json().then(({ p_kind, p_slug }) => {
            if (dataset?.public_documents && Object.hasOwn(dataset.public_documents, p_kind)) {
              return Response.json(dataset.public_documents[p_kind]);
            }
            if (["news", "warnings"].includes(p_kind)) return Response.json(null);
            return Response.json(p_kind === "location"
              ? storedSnapshot.locations.find(location => location.slug === p_slug) || null : storedSnapshot);
          });
        }
        assert.ok(!dataset?.forbidRawReads, `Prepared feeds must not query ${table}`);
        return Response.json(dataset ? dataset[table] || [] : table === "tumedved_logs" ? [sighting] : []);
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
  response = await get("/api/stats");
  assert.equal(response.status, 200);
  const stats = await response.json();
  assert.equal(stats.totals.sightings, 2, "Statistics come from the snapshot, not the one live fixture sighting");
  assert.equal(stats.updatedAt, storedSnapshot.updatedAt);
  for (const route of ["/domov", "/vyskyt-medveda/brezno"]) {
    response = await get(route);
    assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
    assert.match(await response.text(), /Brezno/);
  }
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
  assert.deepEqual(config.triggers.crons, [], "Notification cron stays disabled");
  console.log("Workers checks passed: API, runtime secrets, tiles, SSR, assets, admin authentication and gazetteer");
} finally {
  await runtime.dispose();
}

const pendingSnapshot = createRuntime(fixtures, false, { public_snapshot: null });
try {
  for (const route of ["/api/stats", "/vyskyt-medveda/brezno"]) {
    const response = await pendingSnapshot.dispatchFetch(`https://www.kdejemedved.sk${route}`);
    assert.equal(response.status, 503, "Pending background computation never produces a false 404 or a visitor computation");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  console.log("Workers checks passed: saved statistics/location JSON and pending-snapshot responses");
} finally { await pendingSnapshot.dispose(); }

const prepared = createRuntime(fixtures, false, { forbidRawReads: true, public_documents: {
  news: { items: [{ id: "prepared-news", title: "Uložená správa", date: "2026-10-18T10:00:00Z" }], updatedAt: storedSnapshot.updatedAt },
  warnings: { items: storedSnapshot.warnings, updatedAt: storedSnapshot.updatedAt },
} });
try {
  for (const [route, count] of [["/api/news", 1], ["/api/warnings", 2]]) {
    const response = await prepared.dispatchFetch(`https://www.kdejemedved.sk${route}`);
    assert.equal(response.status, 200, route);
    assert.equal((await response.json()).items.length, count);
  }
  console.log("Workers checks passed: prepared feeds bypass all source-table and incident-link queries");
  const beforeCachedRead = databaseRequests;
  for (const route of ["/api/news", "/api/warnings"]) {
    const response = await prepared.dispatchFetch(`https://www.kdejemedved.sk${route}`);
    assert.equal(response.headers.get("x-medved-cache"), "HIT", "Public replies bypass Express on cache hits");
    await response.arrayBuffer();
  }
  assert.equal(databaseRequests, beforeCachedRead, "Cached replies need no database transfer");
  const privateResponse = await prepared.dispatchFetch("https://www.kdejemedved.sk/api/stats", {
    headers: { cookie: "private=session" },
  });
  assert.equal(privateResponse.headers.get("x-medved-cache"), null, "Cookie requests bypass shared caching");
  await privateResponse.arrayBuffer();
  console.log("Workers checks passed: shared public response caching and private-request exclusion");
} finally { await prepared.dispose(); }

// Exercise cold page/API requests with populated feeds rather than an empty
// news fixture, which cannot reveal resource-heavy directory construction.
const largeSightings = Array.from({length:650}, (_,i) => ({
  ...sighting, id:`large-warning-${i}`, note:`Hlásenie číslo ${i}`,
  reported_at:new Date(Date.UTC(2026,9,12-i,10)).toISOString(),
}));
const largeNews = Array.from({length:220}, (_,i) => ({
  id:`large-news-${i}`, source:"Testovací spravodajský zdroj",
  title:`Medveď pri Brezne: správa ${i}`, snippet:`Hlásenie z okolia Brezna číslo ${i}`,
  article_url:`https://example.com/news/${i}`, published_at:"2026-10-07T10:00:00Z",
  scraped_at:"2026-10-12T10:00:00Z", status:"approved", category:i%4===0?"warning":"article",
  place:i%4===0?"Brezno":null, lat:i%4===0?48.805:null, lng:i%4===0?19.641:null,
  has_coords:i%4===0, payload:{},
}));
const populated = createRuntime(fixtures, false, {tumedved_logs:largeSightings,news_logs:largeNews});
try {
  const routes=["/","/api/news?v=news-map-v9","/api/warnings?v=news-map-v9"];
  await Promise.all(routes.map(async route => {
    const response = await populated.dispatchFetch(`https://www.kdejemedved.sk${route}`);
    assert.equal(response.status,200,route);
    if(route==="/") assert.match(await response.text(),/<!doctype html>/i);
    else {
      assert.match(response.headers.get("content-type"),/application\/json/,route);
      const data=await response.json();
      assert.equal(data.items.length,route.startsWith("/api/news")?220:650,route);
    }
  }));
  const response = await populated.dispatchFetch("https://www.kdejemedved.sk/");
  assert.match(await response.text(),/Medveď pri Brezne/,"Populated news reaches the server-rendered map list");
  console.log("Workers checks passed: simultaneous cold map, 220 news articles and 650 warnings");
} finally { await populated.dispose(); }

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
