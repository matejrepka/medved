import assert from "node:assert/strict";
import { once } from "node:events";
import { chromium } from "playwright";

Object.assign(process.env, {
  SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", EMAIL_ENABLED: "false",
  TELEGRAM_ENABLED: "false", DISABLE_WEBSITE_LOGS: "true", DISABLE_STARTUP_REFRESH: "true",
});
const { app } = await import("../server.js");
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const gate = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};
const reverse = gate(), confirmation = gate(), search = gate(), stats = gate();
const tile = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  context.setDefaultTimeout(10000);
  await context.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException("Storage disabled", "SecurityError"); };
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = ms => timeout(ms === 15000 ? 100 : ms);
    Object.defineProperty(navigator, "geolocation", { value: {
      getCurrentPosition: callback => { window.fixturePosition = callback; },
    } });
  });
  let missingChart = false, stalledStats = false;
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.hostname === "nominatim.openstreetmap.org") {
      if (url.pathname === "/search") {
        await search.promise;
        return route.fulfill({ json: [{ lat: "48.8", lon: "19.6", display_name: "Starý výsledok" }] });
      }
      const old = url.searchParams.get("lat") === "48.8";
      if (old) await reverse.promise;
      if (url.searchParams.get("lat") === "48.9") await confirmation.promise;
      return route.fulfill({ json: { address: { town: old ? "Staré miesto" : "Nové miesto" } } });
    }
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith("/api/map-tiles/")) return route.fulfill({ contentType: "image/png", body: tile });
    if (url.pathname === "/vendor/chart/chart.umd.js" && missingChart) return route.abort();
    if (url.pathname === "/api/stats") {
      if (stalledStats) { await stats.promise; return route.abort(); }
      return route.fulfill({ json: { totals: { sightings: 12, news: 3, todaySightings: 1 },
        topPlace: "Brezno", timeline: [], topLocations: [], timeOfDay: {}, updatedAt: "2026-11-06T12:00:00Z" } });
    }
    return route.continue();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin + "/nahlas", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => { window.oldSelection = selectLocation(48.8, 19.6); });
  await page.evaluate(() => selectLocation(49.1, 19.1));
  assert.equal(await page.locator("#location").inputValue(), "Nové miesto");
  reverse.release();
  await page.evaluate(() => window.oldSelection);
  assert.equal(await page.locator("#location").inputValue(), "Nové miesto", "Late reverse geocoding cannot change the latest location");
  assert.equal(await page.locator("#lat").inputValue(), "49.100000");

  await page.evaluate(() => { window.pendingConfirmation = selectLocation(48.9, 19.6); });
  await page.locator("#confirmLocationBtn").click();
  confirmation.release();
  await page.evaluate(() => window.pendingConfirmation);
  assert.match(await page.locator("#locationStatus").textContent(), /Poloha potvrdená/,
    "Geocoding cannot replace the confirmation status after the user confirms");
  assert.equal(await page.locator("#location").inputValue(), "48.90000, 19.60000");

  await page.locator("#locationSearch").fill("Starý výsledok");
  await page.evaluate(() => { window.oldSearch = doSearch(); });
  await page.evaluate(() => selectLocation(49.2, 19.2));
  search.release();
  await page.evaluate(() => window.oldSearch);
  assert.equal(await page.locator("#lat").inputValue(), "49.200000", "Late search cannot move the chosen marker");

  await page.locator("#locateBtn").click();
  await page.evaluate(() => selectLocation(49.3, 19.3));
  await page.evaluate(() => window.fixturePosition({ coords: { latitude: 48.8, longitude: 19.6 } }));
  assert.equal(await page.locator("#lat").inputValue(), "49.300000", "Late device positioning cannot replace a manual choice");
  await page.locator("#confirmLocationBtn").click();
  assert.match(await page.locator("#locationStatus").textContent(), /Poloha potvrdená/);
  await page.locator("#themeBtn").evaluate(button => button.click());
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark", "Theme survives denied browser storage");
  console.log("Resilience OK: reverse/search/device location races, confirmation and denied storage");

  await page.goto(origin + "/stats", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.getElementById("statTotalSightings").textContent === "12");
  assert.equal(await page.evaluate(() => Chart.instances && Object.keys(Chart.instances).length), 3);
  missingChart = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.getElementById("statTotalSightings").textContent === "12");
  assert.match(await page.locator("#statsStatus").textContent(), /Grafy sa nepodarilo/);
  stalledStats = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.getElementById("statsStatus")?.classList.contains("error"));
  assert.match(await page.locator("#statsStatus").textContent(), /Nepodarilo sa načítať dáta/);
  assert.deepEqual(errors, [], "Degraded dependencies cannot cause uncaught JavaScript exceptions");
  console.log("Resilience OK: healthy charts, blocked chart library and stalled statistics API");
} finally {
  reverse.release(); confirmation.release(); search.release(); stats.release();
  await browser?.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
