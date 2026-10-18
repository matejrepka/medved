import test from "node:test";
import assert from "node:assert/strict";
import { publicCacheUrl, publicCacheTtl, clientCacheResponse, canStorePublicResponse } from "../workers/public-cache.js";

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
  for (const route of ["/varovania/ilava-75acb52874", "/spravy/article-75acb52874"]) {
    assert.ok(publicCacheUrl(request(route), "one"), "Both detail types use the shared response cache");
  }
  assert.notEqual(first, publicCacheUrl(request("/api/news?v=site"), "two"));
  assert.notEqual(publicCacheUrl(request("/spravy?q=Brezno"), "one"), publicCacheUrl(request("/spravy?q=Poprad"), "one"));
  assert.equal(canStorePublicResponse(new Response("ok", { headers: { "cache-control": "public, max-age=60" } })), true);
  for (const response of [new Response("error", { status: 503 }),
    new Response("private", { headers: { "cache-control": "private, no-store" } }),
    new Response("cookie", { headers: { "cache-control": "public", "set-cookie": "session=private" } })]) {
    assert.equal(canStorePublicResponse(response), false);
  }
});

test("record HTML stays at the edge longer without extending the browser's revision window", () => {
  for (const path of ["/varovania/ilava-75acb52874", "/spravy/article-75acb52874"]) {
    assert.equal(publicCacheTtl(new Request(`https://www.kdejemedved.sk${path}`)), 3600);
  }
  for (const path of ["/api/warnings", "/varovania", "/varovania?q=Ilava", "/"]) {
    assert.equal(publicCacheTtl(new Request(`https://www.kdejemedved.sk${path}`)), 60);
  }
  const cached = clientCacheResponse(new Response("detail", {
    headers: { "Cache-Control": "public, max-age=3600" },
  }), "HIT");
  assert.equal(cached.headers.get("cache-control"), "public, max-age=15");
});
