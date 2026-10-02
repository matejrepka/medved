import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

// Override before importing dotenv/server: no production DB, scrapers or mail.
Object.assign(process.env, {
  SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", EMAIL_ENABLED: "false",
  TELEGRAM_ENABLED: "false", DISABLE_WEBSITE_LOGS: "true",
  DISABLE_STARTUP_REFRESH: "true", ADMIN_PASSWORD: "čučoriedka:secret:123",
  CARTO_BASEMAPS_API_KEY: "", TRUST_PROXY: "true",
});
const { app } = await import("../server.js");

test("HTTP security and validation regressions", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const authorization = `Basic ${Buffer.from(`admin:${process.env.ADMIN_PASSWORD}`).toString("base64")}`;
  const post = (url, body, headers = {}) => fetch(origin + url, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });

  await t.test("colon and Unicode admin credentials work; wrong scheme is rejected", async () => {
    const valid = await fetch(origin + "/api/admin/content", { headers: { authorization } });
    assert.equal(valid.status, 200);
    assert.equal(valid.headers.get("cache-control"), "no-store");
    const invalid = await fetch(origin + "/api/admin/content", { headers: { authorization: authorization.replace("Basic", "Bearer") } });
    assert.equal(invalid.status, 401);
  });
  await t.test("cross-site admin writes are denied", async () => {
    const res = await post("/api/admin/reports/1/status", { status: "approved" }, { authorization, Origin: "https://attacker.example" });
    assert.equal(res.status, 403);
  });
  await t.test("invalid subscription area is a 400 response and server stays alive", async () => {
    const res = await post("/api/subscriptions", { email: "test@example.sk", notifyType: "area", areaName: {} });
    assert.equal(res.status, 400);
    assert.equal((await fetch(origin + "/api/status")).status, 200);
  });
  await t.test("poll choice objects cannot crash the async request handler", async () => {
    const res = await post("/api/feedback", { kind: "newsletter_poll", choice: { toString: {} } });
    assert.equal(res.status, 400);
    assert.equal((await fetch(origin + "/api/status")).status, 200);
  });
  await t.test("invalid reports reject before DB and unavailable storage cannot return success", async () => {
    const malformed = await post("/api/reports", { location: "Turany", description: {} });
    assert.equal(malformed.status, 400);
    const unavailable = await post("/api/reports", { location: "Turany", lat: 49.1, lng: 19.03 });
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).ok, false);
  });
  await t.test("malformed and oversized bodies return safe JSON errors", async () => {
    const malformed = await fetch(origin + "/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{broken" });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).ok, false);
    const oversized = await post("/api/feedback", { message: "a".repeat(40_000) });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).ok, false);
  });
  await t.test("report throttling ignores forged earlier proxy hops", async () => {
    const headers = { "X-Forwarded-For": "198.51.100.1, 203.0.113.7" };
    for (let i = 0; i < 5; i++) assert.equal((await post("/api/reports", {}, headers)).status, 400);
    headers["X-Forwarded-For"] = "198.51.100.2, 203.0.113.7";
    const blocked = await post("/api/reports", {}, headers);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("retry-after"), "900");
  });
  await t.test("admin login failures are throttled", async () => {
    const headers = { "X-Forwarded-For": "203.0.113.8", authorization: "Basic YWRtaW46d3Jvbmc=" };
    for (let i = 0; i < 10; i++) assert.equal((await fetch(origin + "/api/admin/content", { headers })).status, 401);
    assert.equal((await fetch(origin + "/api/admin/content", { headers })).status, 429);
  });
  await t.test("tile bounds reject invalid requests before contacting CARTO", async () => {
    for (const tile of ["light_all/21/0/0.png", "light_all/1/2/0.png", "bad/1/0/0.png"]) {
      assert.equal((await fetch(origin + "/api/map-tiles/" + tile)).status, 400);
    }
    assert.equal((await fetch(origin + "/api/map-tiles/light_all/1/0/0.png")).status, 503);
  });
  await t.test("admin aliases and token pages prevent caching, framing and referrer leaks", async () => {
    for (const route of ["/admin", "/admin.html", "/api/subscriptions/confirm?token=invalid"]) {
      const res = await fetch(origin + route, { redirect: "manual" });
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
      assert.equal(res.headers.get("x-frame-options"), "DENY");
    }
  });
});
