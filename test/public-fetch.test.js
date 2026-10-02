import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { fetchPublicArticle, isPublicAddress, publicTarget } from "../src/scrapers/public-fetch.js";

const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
function response(statusCode, headers, body = "") {
  return Object.assign(Readable.from([Buffer.from(body)]), { statusCode, headers });
}

test("article targets reject local, private, mapped, encoded and non-HTTP addresses", async () => {
  for (const address of ["127.0.0.1", "10.0.0.2", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fe80::1", "fc00::1", "2002:7f00:1::"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  for (const url of ["http://127.1", "http://2130706433", "http://0x7f000001", "http://[::1]", "file:///etc/passwd", "http://user:pass@example.com", "http://example.com:8080"]) {
    await assert.rejects(publicTarget(url, lookup));
  }
  await assert.rejects(publicTarget("https://example.com", async () => [
    { address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 },
  ]));
});

test("redirects to private networks are blocked before the next connection", async () => {
  let requests = 0;
  await assert.rejects(fetchPublicArticle("https://example.com", {
    lookup,
    request: async ({ pinned }) => {
      assert.equal(pinned.address, "93.184.216.34");
      requests++;
      return response(302, { location: "http://169.254.169.254/latest/meta-data/" });
    },
  }), /non-public/);
  assert.equal(requests, 1);
});

test("public article responses work and oversized and compressed bodies are bounded", async () => {
  const result = await fetchPublicArticle("https://example.com", {
    lookup, request: async () => response(200, { "content-type": "text/html" }, "<h1>Article</h1>"),
  });
  assert.equal(await result.text(), "<h1>Article</h1>");
  for (const compressed of [false, true]) {
    await assert.rejects(fetchPublicArticle("https://example.com", {
      lookup, maxBytes: 100,
      request: async () => response(200, compressed ? { "content-encoding": "gzip" } : {},
        compressed ? gzipSync("a".repeat(1000)) : "a".repeat(1000)),
    }), /too large/);
  }
});
