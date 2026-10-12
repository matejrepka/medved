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
const newsItem = {
  id: "incident-startup-news", incidentId: "startup-news", isIncident: true,
  title: "Stret medveďa s bežcom na Kláštorskej ceste", category: "warning",
  date: "2026-10-07", source: "ŠOP SR", articleUrl: "https://www.pozormedved.sk/test",
  detailUrl: "/varovania/test", summary: "Zásahový tím monitoruje Kláštorskú cestu.",
  locations: [{ place: "Kláštorská cesta", lat: 48.9526744, lng: 20.3988546 }],
  verificationStatus: "official_notice", sourceCount: 2,
  coverage: [
    { id: "official", source: "ŠOP SR", sourceTypeLabel: "Úradné oznámenie", url: "https://www.pozormedved.sk/test", publishedAt: "2026-10-07" },
    { id: "media", source: "TASR", sourceTypeLabel: "Prevzatá správa", url: "https://www.teraz.sk/test", publishedAt: "2026-10-08" },
  ],
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
          return route.fulfill({ json: { items: [newsItem], updatedAt: newsItem.date } });
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
      assert.ok(await page.locator(".map-startup-art").evaluate(svg => {
        const land = svg.querySelector(".map-startup-land");
        const ring = svg.querySelector(".map-startup-ring-track");
        const toLand = land.getCTM().inverse();
        const fromRing = ring.getCTM();
        // Check the full circle, its stroke, and a little breathing room.
        const radius = ring.r.baseVal.value + 6;
        return Array.from({ length: 128 }, (_, i) => {
          const angle = i * Math.PI * 2 / 128;
          const point = new DOMPoint(Math.cos(angle) * radius, Math.sin(angle) * radius)
            .matrixTransform(fromRing).matrixTransform(toLand);
          return land.isPointInFill(point);
        }).every(Boolean);
      }), "The entire loading ring must sit inside Slovakia");
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
      const newsFirst = name === "mobile";
      (newsFirst ? news : sightings).release();
      await page.locator(newsFirst ? "#newsList .card" : "#sightingsList .card").first().waitFor({ state: "attached" });
      assert.ok(await page.locator("#mapStartup").isVisible(), "Data alone cannot dismiss the tile loader");
      tiles.release();
      await page.locator(".leaflet-tile-loaded").first().waitFor({ state: "attached" });
      // Advance past the introduction: the remaining feed, rather than the
      // minimum display time, must now be what keeps the map covered.
      await page.waitForTimeout(2100);
      assert.ok(await page.locator("#mapStartup").isVisible(), "Tiles cannot dismiss the loader while either feed is pending");
      assert.equal(await page.locator("#map").getAttribute("aria-busy"), "true");
      assert.equal(await page.locator(newsFirst ? "#sightingsList" : "#newsList").getAttribute("aria-busy"), "true");
      (newsFirst ? sightings : news).release();
      await page.locator("#mapStartup").waitFor({ state: "hidden" });
      await page.locator("#mapLoadStatus").waitFor({ state: "hidden" });
      assert.equal(await page.locator("#map").getAttribute("aria-busy"), "false");
      assert.equal(await page.locator("#newsList").getAttribute("aria-busy"), "false");
      assert.equal(await page.locator("#newsCount").textContent(), "1");
      assert.match(await page.locator("#newsList").textContent(), /Kláštorskej ceste/);
      assert.ok(await page.locator("#newsList .coverage-details").count());
      assert.ok(await page.locator(".leaflet-marker-icon").count());
      assert.deepEqual(errors, [], "No startup JavaScript errors");
      console.log(`Startup OK: ${name}; first paint ${firstPaint}ms; map waits for tiles, warnings and populated news`);
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
    await page.locator("[data-consent='necessary']").click();
    assert.match(await page.locator("#mapStartupTitle").textContent(), /nepodarilo/);
    assert.ok(await page.locator("#mapStartupRetry").isVisible());
    assert.equal(await page.locator("#mapStartupRetry").getAttribute("href"), "/?theme=dark");
    await page.locator('.map-startup-actions a[href="#aktuality"]').click();
    await page.waitForFunction(() => {
      const el = document.getElementById("activityTitle");
      const rect = el.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight;
    });
    failTiles = false;
    await page.locator("#mapStartupRetry").click();
    await page.waitForFunction(() => document.querySelector("#newsList [data-source-load-error]") !== null);
    assert.ok(await page.locator("#mapStartup").isVisible(), "Failed news keeps the map covered");
    assert.match(await page.locator("#mapStartupDetail").textContent(), /správy/);
    assert.match(await page.locator("#newsList").textContent(), /sa nepodarilo načítať/);
    assert.equal(await page.locator("#newsList").getAttribute("aria-busy"), "false");
    failNews = false;
    await page.locator("#mapStartupRetry").click();
    await page.locator("#mapStartup").waitFor({ state: "hidden" });
    await page.locator("#mapLoadStatus").waitFor({ state: "hidden" });
    assert.ok(await page.locator(".leaflet-marker-icon").count());
    failLibrary = true;
    await page.goto(origin, { waitUntil: "networkidle" });
    assert.match(await page.locator("#mapStartupTitle").textContent(), /nepodarilo/);
    assert.ok(await page.locator("#mapStartupRetry").isVisible());
    assert.deepEqual(errors, [], "Failed libraries must not trigger cascading JavaScript errors");
    console.log("Startup OK: tile failure, accessible listings, news error replaces loading text, retry, missing map library");
  } finally { await context.close(); }

  const timeoutContext = await browser.newContext();
  const stalledNews = gate();
  try {
    await timeoutContext.addInitScript(() => {
      // Use the real browser abort mechanism with a short test deadline.
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = ms => timeout(ms === 30000 ? 100 : ms);
      const interval = window.setInterval.bind(window);
      window.setInterval = (callback, ms, ...args) => {
        if (ms === 15 * 60 * 1000) window.retryMapFeeds = callback;
        return interval(callback, ms, ...args);
      };
    });
    let stall = true, failRefresh = false;
    await timeoutContext.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname.startsWith("/api/map-tiles/")) return route.fulfill({ contentType: "image/png", body: tile });
      if (url.pathname === "/api/warnings") return route.fulfill({ json: { items: [warning] } });
      if (url.pathname === "/api/news") {
        if (stall) { await stalledNews.promise; return route.abort(); }
        if (failRefresh) return route.fulfill({ status: 503, json: {} });
        return route.fulfill({ json: { items: [newsItem] } });
      }
      return route.continue();
    });
    const page = await timeoutContext.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator("#newsList [data-source-load-error]").waitFor({ state: "attached" });
    assert.ok(await page.locator("#mapStartup").isVisible());
    assert.equal(await page.locator("#newsList").getAttribute("aria-busy"), "false");
    assert.doesNotMatch(await page.locator("#newsList").textContent(), /sa načítavajú/);
    stall = false; stalledNews.release();
    await page.locator("#newsList [data-retry-source]").click();
    await page.locator("#mapStartup").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#newsList .card").count(), 1);
    failRefresh = true;
    await page.evaluate(() => window.retryMapFeeds());
    assert.ok(await page.locator("#mapStartup").isHidden(), "A failed refresh does not cover an already usable map");
    assert.equal(await page.locator("#newsList .card").count(), 1, "Failed refresh preserves the existing news card");
    assert.ok(await page.locator("#newsList [data-retry-source]").isVisible());
    assert.deepEqual(errors, []);
    console.log("Startup OK: stalled news times out, list retry recovers, failed refresh preserves content");
  } finally { stalledNews.release(); await timeoutContext.close(); }

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
