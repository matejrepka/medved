import assert from "node:assert/strict";
import test from "node:test";
import Parser from "rss-parser";
import { fetchNews } from "../src/scrapers/news.js";

const mockPosts = (t, reply) => t.mock.method(globalThis, "fetch", async input => {
  const url = new URL(input instanceof Request ? input.url : input);
  assert.equal(url.hostname, "pozormedved.sk", "Fixtures must not contact other services");
  return reply();
});
const rss = (title, isoDate) => ({ title, isoDate, link: "" });
const post = (id, date_gmt) => ({ id, date_gmt, title: { rendered: `Medveď pri kamere ${id}` } });

test("one malformed RSS timestamp cannot discard other articles", async t => {
  t.mock.method(Parser.prototype, "parseURL", async () => ({ items: [
    rss("Medveď pri kamere", "invalid date"), rss("Medveď v lese", "2026-11-05T12:00:00Z"),
  ] }));
  mockPosts(t, () => Response.json([]));
  const items = await fetchNews();
  assert.equal(items.length, 2);
  assert.ok(items.some(item => item.title === "Medveď v lese"));
});

test("one malformed WordPress timestamp cannot discard a source batch", async t => {
  t.mock.method(Parser.prototype, "parseURL", async () => ({ items: [] }));
  mockPosts(t, () => Response.json([post(1, "2026-11-05T12:00:00"), post(2, "invalid date")]));
  const items = await fetchNews();
  assert.equal(items.length, 2);
  assert.equal(items.find(item => item.id === "news-pm1").date, "2026-11-05T12:00:00.000Z");
  assert.equal(items.find(item => item.id === "news-pm2").date, null);
});

test("a complete news-source outage fails instead of reporting an empty successful refresh", async t => {
  t.mock.method(Parser.prototype, "parseURL", async () => { throw new Error("RSS unavailable"); });
  mockPosts(t, () => new Response("Unavailable", { status: 500 }));
  await assert.rejects(fetchNews(), /zdroj správ/);
});

test("an invalid WordPress payload is a source failure, not an empty source", async t => {
  t.mock.method(Parser.prototype, "parseURL", async () => { throw new Error("RSS unavailable"); });
  mockPosts(t, () => Response.json({ error: "Unexpected object" }));
  await assert.rejects(fetchNews(), /zdroj správ/);
});

test("a healthy source still supplies news when another is unavailable", async t => {
  t.mock.method(Parser.prototype, "parseURL", async () => ({ items: [rss("Medveď v lese", null)] }));
  mockPosts(t, () => new Response("Unavailable", { status: 500 }));
  assert.equal((await fetchNews()).length, 1);
});

test("successful empty upstream responses remain valid", async t => {
  t.mock.method(Parser.prototype, "parseURL", async () => ({ items: [] }));
  mockPosts(t, () => Response.json([]));
  assert.deepEqual(await fetchNews(), []);
});
