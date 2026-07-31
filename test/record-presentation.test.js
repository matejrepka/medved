import test from "node:test";
import assert from "node:assert/strict";

import {
  correctionMailto,
  newsRecordKind,
  recordFreshness,
  warningRecordKind,
} from "../src/record-presentation.js";

test("community report is not presented as field-verified", () => {
  const kind = warningRecordKind({ sourceType: "report" });
  assert.equal(kind.key, "community");
  assert.match(kind.explanation, /nie overené v teréne/);
});

test("an external map entry is presented as a sourced record, not an official warning", () => {
  const kind = warningRecordKind({ sourceKey: "tumedved", source: "tumedved.sk" });
  assert.equal(kind.key, "sourced");
});

test("ŠOP SR and Pozor Medveď news are recognized as official sources", () => {
  assert.equal(newsRecordKind({ source: "ŠOP SR", category: "warning" }).key, "official");
  assert.equal(
    newsRecordKind({ articleUrl: "https://www.pozormedved.sk/upozornenie", category: "warning" }).key,
    "official"
  );
});

test("ordinary warning coverage remains a media warning", () => {
  const kind = newsRecordKind({ source: "Regionálne správy", category: "warning" });
  assert.equal(kind.key, "media-warning");
});

test("freshness uses clear, non-realtime age bands", () => {
  const now = new Date("2026-07-31T12:00:00.000Z");
  assert.equal(recordFreshness("2026-07-31T08:00:00.000Z", now).key, "today");
  assert.equal(recordFreshness("2026-07-27T08:00:00.000Z", now).key, "week");
  assert.equal(recordFreshness("2026-07-10T08:00:00.000Z", now).key, "month");
  assert.equal(recordFreshness("2026-06-01T08:00:00.000Z", now).key, "older");
});

test("correction link identifies the record without exposing reporter data", () => {
  const href = correctionMailto({ id: "report-42", location: "Važec" }, "komunitné hlásenie");
  assert.match(href, /^mailto:kontakt@kdejemedved\.sk\?/);
  assert.match(decodeURIComponent(href), /report-42/);
  assert.match(decodeURIComponent(href), /Važec/);
});
