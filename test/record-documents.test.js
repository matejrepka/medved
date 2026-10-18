import test from "node:test";
import assert from "node:assert/strict";
import { buildRecordDocuments, recordToken } from "../src/record-documents.js";

test("detail documents preserve warning aliases, news redirects, location links and bounded related cards", () => {
  const warnings = [{ id: "one", location: "Žilina", bucketMemberIds: ["one", "alias"] }];
  const news = Array.from({ length: 8 }, (_, id) => ({ id: `news-${id}`, title: `Article ${id}`,
    category: id === 0 ? "warning" : "article", place: "Žilina", date: "2026-10-18T10:00:00Z" }));
  const docs = buildRecordDocuments({ warnings, news, locations: [{ slug: "zilina" }] });
  const warning = docs[`warning:${recordToken("one")}`];
  assert.deepEqual(docs[`warning:${recordToken("alias")}`], warning);
  assert.equal(warning.record.id, "one");
  assert.deepEqual(warning.locations, [{ slug: "zilina" }]);
  assert.equal(warning.related.length, 1);
  const article = docs[`news:${recordToken("news-1")}`];
  assert.equal(article.recordType, "news");
  assert.equal(article.related.length, 4);
  assert.ok(article.related.every(item => item.id !== "news-1"));
  assert.equal(docs[`warning:${recordToken("news-0")}`].recordType, "news");
  assert.equal(docs[`news:${recordToken("news-0")}`].record.category, "warning");
  assert.equal(docs[`warning:${recordToken("news-1")}`], undefined);
});
