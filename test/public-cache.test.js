import test from "node:test";
import assert from "node:assert/strict";
import { publicCacheUrl, canStorePublicResponse } from "../workers/public-cache.js";

test("shared public caching excludes credentials, mutations, arbitrary queries and private errors", () => {
  const request = (path, init) => new Request(`https://www.kdejemedved.sk${path}`, init);
  for (const path of ["/api/admin/content", "/admin", "/api/status", "/api/news?token=secret", "/api/stats?__medved_cache=attacker"]) {
    assert.equal(publicCacheUrl(request(path), "one"), null, path);
  }
  for (const init of [{ method: "POST" }, { method: "HEAD" }, { headers: { authorization: "Basic private" } },
    { headers: { cookie: "session=private" } }, { headers: { range: "bytes=0-10" } }]) {
    assert.equal(publicCacheUrl(request("/api/news", init), "one"), null);
  }
  const first = publicCacheUrl(request("/api/news?v=site"), "one");
  assert.notEqual(first, publicCacheUrl(request("/api/news?v=site"), "two"));
  assert.notEqual(publicCacheUrl(request("/spravy?q=Brezno"), "one"), publicCacheUrl(request("/spravy?q=Poprad"), "one"));
  assert.equal(canStorePublicResponse(new Response("ok", { headers: { "cache-control": "public, max-age=60" } })), true);
  for (const response of [new Response("error", { status: 503 }),
    new Response("private", { headers: { "cache-control": "private, no-store" } }),
    new Response("cookie", { headers: { "cache-control": "public", "set-cookie": "session=private" } })]) {
    assert.equal(canStorePublicResponse(response), false);
  }
});
