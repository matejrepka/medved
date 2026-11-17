import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import sharp from "sharp";

Object.assign(process.env, {
  SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", SMTP_HOST: "",
  EMAIL_ENABLED: "false", TELEGRAM_ENABLED: "false",
  DISABLE_WEBSITE_LOGS: "true", DISABLE_STARTUP_REFRESH: "true",
});
const { app } = await import("../server.js");
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const tileColor = [47, 54, 48];
const tile = await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 47, g: 54, b: 48 } } }).png().toBuffer();
const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport });
      try {
        await context.addInitScript(theme => localStorage.setItem("theme", theme), theme);
        await context.route("**/*", route => {
          const url = new URL(route.request().url());
          if (url.pathname.startsWith("/api/map-tiles/") || /tile|arcgisonline/.test(url.hostname)) {
            return route.fulfill({ contentType: "image/png", body: tile });
          }
          if (url.origin !== origin) return route.abort();
          if (["/api/warnings", "/api/news"].includes(url.pathname)) return route.fulfill({ json: { items: [] } });
          if (url.pathname === "/app.js") {
            // Keep the real map available for geographic assertions in this test only.
            return route.fulfill({ contentType: "text/javascript", body: `const createMap = L.map; L.map = (...args) => window.testMap = createMap(...args);\n${appSource}` });
          }
          return route.continue();
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(origin, { waitUntil: "networkidle" });
        await page.locator("#mapStartup").waitFor({ state: "hidden" });
        const checkMask = async () => {
          assert.deepEqual(await page.evaluate(() => {
            const path = document.querySelector(".map-country-mask");
            const rect = document.getElementById("map").getBoundingClientRect();
            return [
              [48.1486, 17.1077], // Bratislava
              [48.7164, 21.2611], // Košice
              [49.05, 20.3], // Poprad
              [48.208, 16.373], // Vienna
              [49.195, 16.607], // Brno
              [47.498, 19.04], // Budapest
              [50.061, 19.938], // Kraków
              [48.621, 22.287], // Uzhhorod
            ].map(point => {
              const pixel = window.testMap.latLngToContainerPoint(point);
              return path.isPointInFill(new DOMPoint(pixel.x + rect.left, pixel.y + rect.top).matrixTransform(path.getScreenCTM().inverse()));
            });
          }), [false, false, false, true, true, true, true, true], "Only Slovakia is left uncovered");
          assert.equal(await page.locator(".leaflet-tile").first().evaluate(el => getComputedStyle(el).mixBlendMode), "normal");
        };
        await checkMask();
        // Check the mask during a live drag, before Leaflet refreshes its SVG viewport.
        const rect = await page.locator("#map").boundingBox();
        await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
        await page.mouse.down();
        await page.mouse.move(rect.x + rect.width * 0.85, rect.y + rect.height * 0.75, { steps: 8 });
        await checkMask();
        assert.equal(await page.locator(".map-country-pane svg").evaluate(el => getComputedStyle(el).overflow), "visible");
        await page.mouse.up();
        for (const layer of ["standard", "classic", "tourist", "satellite"]) {
          await page.locator(`input[name="mapLayer"][value="${layer}"]`).evaluate(el => {
            el.checked = true;
            el.dispatchEvent(new Event("change", { bubbles: true }));
          });
          await page.evaluate(() => window.testMap.setView([48.7, 19.5], 9, { animate: false }));
          await page.waitForFunction(() => Array.from(document.querySelectorAll(".leaflet-tile")).every(el => el.complete && el.naturalWidth));
          await checkMask();
        }
        // A uniform tile must keep its exact color; blending used to brighten it.
        const point = await page.evaluate(() => {
          const point = window.testMap.latLngToContainerPoint([48.7, 19.5]);
          return { x: point.x, y: point.y };
        });
        const screenshot = await page.locator("#map").screenshot();
        const pixel = await sharp(screenshot).extract({ left: point.x, top: point.y, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
        assert.deepEqual([...pixel], tileColor, "Tiles render without additive brightness");
        assert.deepEqual(errors, [], "No map JavaScript errors");
        console.log(`Map boundary OK: ${viewport.width}px ${theme}, drag, zoom and all four layers`);
      } finally { await context.close(); }
    }
  }
  const page = await browser.newPage();
  await page.route("**/slovakia-boundary.js*", route => route.abort());
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.getElementById("mapStartup").classList.contains("is-error"));
  assert.equal(await page.locator(".leaflet-tile").count(), 0, "Missing boundary must not reveal other countries");
  console.log("Map boundary OK: missing boundary keeps the map covered");
} finally {
  await browser?.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
