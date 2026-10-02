import assert from "node:assert/strict";
import { once } from "node:events";
import { chromium } from "playwright";

Object.assign(process.env, {
  SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", SMTP_HOST: "",
  TELEGRAM_ENABLED: "false", DISABLE_WEBSITE_LOGS: "true",
  DISABLE_STARTUP_REFRESH: "true", ADMIN_PASSWORD: "čučoriedka:browser-test:123",
});
const { app } = await import("../server.js");
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  // Run without production data or external services. Map tiles are fixtures;
  // geocoding, analytics and other third-party calls cannot leave this test.
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/map-tiles/")) {
      return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64") });
    }
    return url.origin === origin ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  const missingAssets = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.origin === origin && response.status() === 404 && /\.(?:js|mjs|css|png|webp|woff2?)$/.test(url.pathname)) missingAssets.push(url.pathname);
  });
  for (const route of ["/", "/domov", "/spravy", "/varovania", "/stats", "/nahlas", "/bezpecnost", "/o-mape", "/ochrana-sukromia", "/podmienky-pouzivania", "/admin"]) {
    const response = await page.goto(origin + route, { waitUntil: "networkidle" });
    assert.equal(response.status(), 200, route);
    assert.ok(await page.locator("h1").count(), `${route} must have a heading`);
    console.log(`Browser OK: ${route}`);
  }
  await page.locator("#loginUser").fill("admin");
  await page.locator("#loginPass").fill(process.env.ADMIN_PASSWORD);
  await page.locator("#loginBtn").click();
  await page.locator("#adminDashboard").waitFor({ state: "visible" });
  console.log("Browser OK: admin login with UTF-8 and colon password");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/nahlas", { waitUntil: "networkidle" });
  await page.locator("[data-consent='necessary']").click();
  await page.locator("#menuBtn").click();
  assert.equal(await page.locator("#siteMenuDialog").evaluate(el => el.open), true);
  await page.locator("[data-menu-close]").click();
  assert.equal(await page.locator("#siteMenuDialog").evaluate(el => el.open), false);
  await page.locator("#submitBtn").click();
  assert.match(await page.locator("#formMessage").textContent(), /Vyberte miesto/);
  console.log("Browser OK: mobile navigation and report validation");
  assert.deepEqual(errors, [], "No browser JavaScript exceptions");
  assert.deepEqual(missingAssets, [], "No missing local assets");
} finally {
  await browser?.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
