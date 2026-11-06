import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

Object.assign(process.env, {
  SUPABASE_URL: "https://admin-input-fixture.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test-only-key",
  ADMIN_PASSWORD: "test-only-password", TELEGRAM_ENABLED: "false", EMAIL_ENABLED: "false",
  DISABLE_WEBSITE_LOGS: "true", DISABLE_STARTUP_REFRESH: "true",
});
const { app } = await import("../server.js");

test("malformed admin dates cannot escape the async handler or reach the database", async t => {
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async () => assert.fail("Invalid dates must be rejected before any database write"));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const date of [{ toString: {} }, {}, [], true, 42, "a".repeat(41), "invalid"]) {
    const response = await realFetch(origin + "/api/admin/warnings", { method: "POST", headers: {
      "Content-Type": "application/json",
      authorization: `Basic ${Buffer.from("admin:test-only-password").toString("base64")}`,
    }, body: JSON.stringify({ type: "news", title: "Medveď", date }) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).ok, false);
    assert.equal((await realFetch(origin + "/api/status")).status, 200);
  }
});
