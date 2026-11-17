import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import sharp from "sharp";
import { ScheduledDataStore } from "../src/scheduled-store.js";

Object.assign(process.env, {
  SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", SMTP_HOST: "",
  EMAIL_ENABLED: "false", TELEGRAM_ENABLED: "false",
  DISABLE_WEBSITE_LOGS: "true", DISABLE_STARTUP_REFRESH: "true",
});
const recent = new Date().toISOString();
const old = new Date(Date.now() - 30 * 86400000).toISOString();
const warning = { id: "bootstrap-recent", location: "Brusno", lat: 48.77, lng: 19.39,
  reportedAt: recent, hasCoords: true, note: '</script><script>window.bootstrapInjection = true</script>', source: "tumedved.sk" };
const warnings = [warning, { ...warning, id: "bootstrap-old", location: "Starší záznam", reportedAt: old }];
const news = [{ id: "bootstrap-news", title: "Varovanie v Brusne", date: recent,
  category: "warning", lat: warning.lat, lng: warning.lng, place: warning.location, hasCoords: true }];
ScheduledDataStore.prototype.get = async function () {
  this.fetchedAt = Date.now();
  return this.name === "sightings" ? warnings : news;
};
const { app } = await import("../server.js");
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const tile = await sharp({ create: { width: 512, height: 512, channels: 3, background: "#e8ece5" } }).png().toBuffer();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const [theme, viewport] of [["light", { width: 390, height: 844 }], ["dark", { width: 390, height: 844 }], ["light", { width: 1440, height: 900 }]]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    try {
      const feeds = [], tiles = [], errors = [];
      await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname.startsWith("/api/map-tiles/")) {
          tiles.push(url.pathname);
          return route.fulfill({ contentType: "image/png", body: tile });
        }
        if (["/api/warnings", "/api/news"].includes(url.pathname)) feeds.push(url.pathname);
        return route.continue();
      });
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      const response = await page.goto(`${origin}/?theme=${theme}`, { waitUntil: "networkidle" });
      const html = await response.text();
      const initial = JSON.parse(await page.locator("#mapInitialData").textContent());
      assert.equal(initial.warnings.length, 1, "History is excluded from the initial payload");
      assert.equal(initial.warnings[0].note, warning.note);
      assert.ok(!html.includes(warning.note), "Untrusted JSON cannot terminate the bootstrap script");
      assert.equal(await page.evaluate(() => window.bootstrapInjection), undefined);
      assert.deepEqual(feeds, [], "SSR data needs no additional feed requests");
      await page.locator("#mapStartup").waitFor({ state: "hidden" });
      assert.ok(tiles.length > 0 && tiles.every(url => /\/9\/\d+\/\d+@2x\.png$/.test(url)), "Only final-view retina tiles are fetched");
      assert.equal(await page.locator("#sightingsList .card").count(), 1);
      assert.equal(await page.locator(".map-marker-count").count(), 1, "Overlapping records share one usable target");
      await page.locator(".map-marker-count").click();
      assert.match(await page.locator(".leaflet-popup-content").textContent(), /Varovanie v Brusne/);
      await page.locator(".leaflet-popup-close-button").click();
      if (process.env.BOOTSTRAP_SCREENSHOT_DIR) {
        await mkdir(process.env.BOOTSTRAP_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${process.env.BOOTSTRAP_SCREENSHOT_DIR}/${theme}-${viewport.width}.png` });
      }
      await page.locator("#filterOpenBtn").click();
      await page.locator("#filterStart").fill("");
      await page.locator("#filterEnd").fill("");
      await page.locator('#mapFilterForm button[type="submit"]').click();
      await page.waitForFunction(() => document.querySelectorAll("#sightingsList .card").length === 2);
      assert.deepEqual(feeds.sort(), ["/api/news", "/api/warnings"], "An expanded date range loads the complete history");
      assert.match(await page.locator("#sightingsList").textContent(), /Starší záznam/);
      assert.deepEqual(errors, []);
      console.log(`Bootstrap OK: ${theme} ${viewport.width}; escaped JSON, no initial feed requests, retina, groups, historical filters`);
    } finally { await context.close(); }
  }
} finally {
  await browser?.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
