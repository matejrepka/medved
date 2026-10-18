import test from "node:test";
import assert from "node:assert/strict";

import { mergeWarnings } from "../src/warnings.js";

const sighting = {
  id: "tm-10",
  source: "tumedved.sk",
  sourceKey: "tumedved",
  location: "Handlová",
  note: "Medveď bol videný v chatovej oblasti.",
  lat: 48.7293,
  lng: 18.76007,
  hasCoords: true,
  reportedAt: "2026-07-12T08:00:00.000Z",
  datePrecision: "datetime",
  url: "https://tumedved.sk/pozorovanie/10",
  sourceLinks: [
    { key: "tumedved", label: "tumedved.sk", url: "https://tumedved.sk/pozorovanie/10", sourceId: "10" },
  ],
};

test("spravodajský odkaz sa nepripojí ani k rovnakému mapovému varovaniu", () => {
  const news = [{
    id: "article-1",
    source: "Miestne správy",
    title: "Medveď sa objavil pri chatách v Handlovej",
    snippet: "Výskyt zaznamenali v chatovej oblasti.",
    articleUrl: "https://spravy.example/handlova-medved",
    category: "warning",
    place: "Handlová",
    lat: 48.7295,
    lng: 18.7602,
    hasCoords: true,
    date: "2026-07-12T09:00:00.000Z",
  }];

  const merged = mergeWarnings({ sightings: [sighting], news });

  assert.equal(merged.length, 1);
  assert.deepEqual(
    merged[0].sourceLinks.map((link) => link.label).sort(),
    ["tumedved.sk"]
  );
});

test("samostatná správa bez zhodného hlásenia sa nepridá do zoznamu hlásení", () => {
  const news = [{
    id: "article-2",
    source: "Iné správy",
    title: "Medveď pri obci Važec",
    snippet: "Samostatné upozornenie.",
    articleUrl: "https://spravy.example/vazec-medved",
    category: "warning",
    place: "Važec",
    lat: 49.05,
    lng: 19.98,
    hasCoords: true,
    date: "2026-07-12T09:00:00.000Z",
  }];

  const merged = mergeWarnings({ sightings: [sighting], news });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, sighting.id);
});

test("identical approved reports stay independent without explicit bucket links", () => {
  const other = { ...sighting, id: "tm-11" };
  assert.equal(mergeWarnings({ sightings: [sighting, other] }).length, 2);
});

test("only stored membership groups warnings, and rejected members cannot reappear", () => {
  const other = { ...sighting, id: "tm-11", source: "mapamedvedov.sk", sourceKey: "mapamedvedov",
    sourceLinks: [{ key: "mapamedvedov", label: "mapamedvedov.sk", url: "https://mapamedvedov.sk/", sourceId: "11" }] };
  const report = { ...sighting, id: "report-42", sourceType: "report", source: "Hlásenie používateľa" };
  const buckets = [{ id: "bucket-1", primaryKey: "sighting:tm-10",
    memberKeys: ["sighting:tm-10", "sighting:tm-11", "report:42"] }];
  const grouped = mergeWarnings({ sightings: [sighting, other], reports: [report], buckets });
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].id, sighting.id);
  assert.equal(grouped[0].bucketMemberIds.length, 3);
  assert.equal(sighting.bucketMemberIds, undefined, "Inputs are not mutated");
  const afterRejection = mergeWarnings({ sightings: [other], buckets });
  assert.equal(afterRejection[0].id, other.id, "Approved fallback replaces rejected primary");
  assert.deepEqual(afterRejection[0].bucketMemberIds, [other.id]);
  assert.equal(mergeWarnings({ buckets }).length, 0);
});
