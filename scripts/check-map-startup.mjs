import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

// No production data, scrapers, notifications, or external network access.
Object.assign(process.env, {
  SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", SMTP_HOST: "",
  EMAIL_ENABLED: "false", TELEGRAM_ENABLED: "false",
  DISABLE_WEBSITE_LOGS: "true", DISABLE_STARTUP_REFRESH: "true",
  // Screenshots must capture the fallback font while font files are held.
  PW_TEST_SCREENSHOT_NO_FONTS_READY: "1",
});
const { app } = await import("../server.js");
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const tile = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
const warning = {
  id: "startup-warning", location: "Liptovský Mikuláš",
  lat: 49.08, lng: 19.61, hasCoords: true, reportedAt: "2026-10-05T09:00:00.000Z",
  source: "tumedved.sk", note: "Testovacie hlásenie",
};
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const [name, viewport, theme] of [
    ["desktop", { width: 1440, height: 900 }, "light"],
    ["mobile", { width: 390, height: 844 }, "light"],
    ["mobile-dark", { width: 320, height: 640 }, "dark"],
  ]) {
    const context = await browser.newContext({ viewport });
    const assets = gate(), tiles = gate(), sightings = gate(), news = gate();
    const errors = [];
    try {
      await context.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname.startsWith("/api/map-tiles/")) {
          await tiles.promise;
          return route.fulfill({ contentType: "image/png", body: tile });
        }
        if (url.pathname === "/api/warnings") {
          await sightings.promise;
          return route.fulfill({ json: { items: [warning], updatedAt: warning.reportedAt } });
        }
        if (url.pathname === "/api/news") {
          await news.promise;
          return route.fulfill({ json: { items: [], updatedAt: null } });
        }
        if (/\.(css|js|woff2)$/.test(url.pathname)) await assets.promise;
        return route.continue();
      });
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${origin}/?theme=${theme}`, { waitUntil: "commit" });
      await page.locator("#mapStartup").waitFor({ state: "visible" });
      await page.waitForFunction(() => performance.getEntriesByName("first-contentful-paint").length > 0);
      const firstPaint = await page.evaluate(() => Math.round(performance.getEntriesByName("first-contentful-paint")[0].startTime));
      // Reaching FCP before any gate is released proves assets cannot block
      // the loading screen; absolute timings vary with the host's CPU load.
      assert.match(await page.locator("#mapStartupTitle").textContent(), /Načítavame mapu Slovenska/);
      assert.equal(await page.locator("#map").getAttribute("aria-busy"), "true");
      assert.ok(await page.locator(".map-startup-land").isVisible());
      assert.ok(await page.locator(".map-startup-logo").isVisible());
      assert.ok(await page.locator(".map-startup-ring-arc").isVisible());
      assert.ok(await page.locator(`.map-startup-logo-${theme === "dark" ? "dark" : "light"}`).isVisible());
      assert.equal(await page.locator(".map-startup-logo image").evaluateAll(images =>
        images.every(image => image.getAttribute("href").startsWith("data:image/png;base64,"))
      ), true, "The loading logo requires no additional image request");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "No horizontal overflow");
      if (process.env.STARTUP_SCREENSHOT_DIR) {
        await mkdir(process.env.STARTUP_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.STARTUP_SCREENSHOT_DIR, `${name}.png`) });
      }
      await page.locator('.map-startup-actions a[href="#aktuality"]').click();
      assert.ok(await page.locator("#activityTitle").isVisible(), "Listings stay accessible even when CSS is stalled");
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(await page.locator(".map-startup-ring-arc").evaluate(el => getComputedStyle(el).animationName), "none");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      assert.notEqual(await page.locator(".map-startup-ring-arc").evaluate(el => getComputedStyle(el).animationName), "none");

      assets.release();
      await page.locator(".leaflet-tile").first().waitFor({ state: "attached" });
      assert.ok(await page.locator("#mapStartup").isVisible(), "Loader stays visible while tiles are pending");
      sightings.release();
      await page.locator(".leaflet-marker-icon").first().waitFor({ state: "attached" });
      assert.ok(await page.locator("#mapStartup").isVisible(), "Data alone cannot dismiss the tile loader");
      tiles.release();
      await page.locator("#mapStartup").waitFor({ state: "hidden" });
      assert.match(await page.locator("#mapLoadStatus").textContent(), /Mapa je pripravená/);
      assert.equal(await page.locator("#map").getAttribute("aria-busy"), "false");
      news.release();
      await page.locator("#mapLoadStatus").waitFor({ state: "hidden" });
      assert.ok(await page.locator(".leaflet-marker-icon").count());
      assert.deepEqual(errors, [], "No startup JavaScript errors");
      console.log(`Startup OK: ${name}; first paint ${firstPaint}ms with all CSS/JS/fonts held; tiles and markers independent of slow news`);
    } finally {
      assets.release(); tiles.release(); sightings.release(); news.release();
      await context.close();
    }
  }

  const fastContext = await browser.newContext();
  try {
    await fastContext.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname.startsWith("/api/map-tiles/")) return route.fulfill({ contentType: "image/png", body: tile });
      if (url.pathname === "/api/warnings") return route.fulfill({ json: { items: [warning] } });
      if (url.pathname === "/api/news") return route.fulfill({ json: { items: [] } });
      return route.continue();
    });
    const page = await fastContext.newPage();
    await page.addInitScript(() => {
      window.startupHiddenAt = null;
      new MutationObserver(() => {
        if (window.startupHiddenAt === null && document.getElementById("mapStartup")?.hidden) {
          window.startupHiddenAt = performance.now();
        }
      }).observe(document, { attributes: true, subtree: true, attributeFilter: ["hidden"] });
    });
    // Repeated visits in one context prove this is not a first-visit-only delay.
    for (const visit of [1, 2]) {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await page.locator(".leaflet-marker-icon").first().waitFor({ state: "attached" });
      await page.locator(".leaflet-tile-loaded").first().waitFor({ state: "attached" });
      assert.ok(await page.locator("#mapStartup").isVisible(), "Map and data load behind the visible introduction");
      await page.waitForFunction(() => window.startupHiddenAt !== null);
      const visibleMs = await page.evaluate(() =>
        window.startupHiddenAt - performance.getEntriesByName("first-contentful-paint")[0].startTime
      );
      assert.ok(visibleMs >= 2000, `Fast visit ${visit} must show the introduction for at least 2 seconds (${visibleMs}ms)`);
      assert.ok(await page.locator(".leaflet-marker-icon").count());
      console.log(`Startup OK: fast visit ${visit}; visible ${Math.round(visibleMs)}ms; map and markers loaded in background`);
    }
  } finally { await fastContext.close(); }

  const context = await browser.newContext();
  try {
    let failTiles = true, failNews = true, failLibrary = false;
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname.includes("/leaflet.js") && failLibrary) return route.abort();
      if (url.pathname.startsWith("/api/map-tiles/")) {
        return failTiles ? route.abort() : route.fulfill({ contentType: "image/png", body: tile });
      }
      if (url.pathname === "/api/warnings") return route.fulfill({ json: { items: [warning] } });
      if (url.pathname === "/api/news") return failNews
        ? route.fulfill({ status: 503, json: { items: [] } })
        : route.fulfill({ json: { items: [] } });
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin + "/?theme=dark", { waitUntil: "networkidle" });
    assert.match(await page.locator("#mapStartupTitle").textContent(), /nepodarilo/);
    assert.ok(await page.locator("#mapStartupRetry").isVisible());
    assert.equal(await page.locator("#mapStartupRetry").getAttribute("href"), "/?theme=dark");
    await page.locator('.map-startup-actions a[href="#aktuality"]').click();
    assert.ok(await page.locator("#activityTitle").evaluate(el => {
      const rect = el.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight;
    }));
    failTiles = false;
    await page.locator("#mapStartupRetry").click();
    await page.locator("#mapStartup").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.getElementById("mapLoadStatus").classList.contains("is-error"));
    assert.match(await page.locator("#mapLoadStatus").textContent(), /správy/);
    failNews = false;
    await page.locator("[data-retry-load]").click();
    await page.locator("#mapLoadStatus").waitFor({ state: "hidden" });
    assert.ok(await page.locator(".leaflet-marker-icon").count());
    failLibrary = true;
    await page.goto(origin, { waitUntil: "networkidle" });
    assert.match(await page.locator("#mapStartupTitle").textContent(), /nepodarilo/);
    assert.ok(await page.locator("#mapStartupRetry").isVisible());
    assert.deepEqual(errors, [], "Failed libraries must not trigger cascading JavaScript errors");
    console.log("Startup OK: tile failure, accessible listings, reload, API failure/retry, missing map library");
  } finally { await context.close(); }

  const slowContext = await browser.newContext();
  const delayedScript = gate();
  try {
    await slowContext.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname.includes("/leaflet.js")) { await delayedScript.promise; return route.abort(); }
      if (url.pathname === "/api/warnings") return route.fulfill({ json: { items: [] } });
      return route.continue();
    });
    const page = await slowContext.newPage();
    await page.clock.install();
    await page.goto(origin, { waitUntil: "commit" });
    await page.locator("#mapStartup").waitFor({ state: "visible" });
    await page.clock.fastForward(8001);
    assert.match(await page.locator("#mapStartupTitle").textContent(), /ešte načítava/);
    assert.ok(await page.locator("#mapStartupRetry").isVisible());
    console.log("Startup OK: stalled scripts get slow-connection guidance and retry after 8 seconds");
  } finally { delayedScript.release(); await slowContext.close(); }

  const noJs = await browser.newContext({ javaScriptEnabled: false });
  try {
    await noJs.route("**/*", route => {
      const url = new URL(route.request().url());
      return url.origin === origin ? route.continue() : route.abort();
    });
    const page = await noJs.newPage();
    await page.goto(origin, { waitUntil: "networkidle" });
    assert.equal(await page.locator("#mapStartup").isVisible(), false);
    assert.ok(await page.locator("#activityTitle").isVisible());
    assert.ok(await page.locator(".map-noscript").isVisible());
    console.log("Startup OK: JavaScript-disabled visitors can read the server-rendered listings");
  } finally { await noJs.close(); }
} finally {
  await browser?.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
