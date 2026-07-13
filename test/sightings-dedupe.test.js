import test from "node:test";
import assert from "node:assert/strict";

import { areSimilarSightings, dedupeSightings } from "../src/sightings-dedupe.js";

function item(overrides = {}) {
  return {
    id: "tm-1",
    source: "tumedved.sk",
    sourceKey: "tumedved",
    location: "Handlová",
    note: "Medveď bol videný v chatárskej oblasti.",
    lat: 48.7293,
    lng: 18.76007,
    hasCoords: true,
    reportedAt: "2026-07-12T18:30:00.000Z",
    datePrecision: "datetime",
    url: "https://tumedved.sk/hlasenie/1",
    sourceLinks: [
      { key: "tumedved", label: "tumedved.sk", url: "https://tumedved.sk/hlasenie/1", sourceId: "1" },
    ],
    ...overrides,
  };
}

test("zlúči podobné hlásenie z troch zdrojov a zachová všetky odkazy", () => {
  const tumedved = item();
  const mapamedvedov = item({
    id: "mapamedvedov-55",
    source: "mapamedvedov.sk",
    sourceKey: "mapamedvedov",
    note: "Pozorovanie medveďa pri chatovej oblasti v Handlovej.",
    lat: 48.7301,
    lng: 18.7597,
    reportedAt: "2026-07-12T12:00:00.000Z",
    datePrecision: "date",
    url: "https://mapamedvedov.sk/pozorovanie/55",
    sourceLinks: [
      { key: "mapamedvedov", label: "mapamedvedov.sk", url: "https://mapamedvedov.sk/pozorovanie/55", sourceId: "55" },
    ],
  });
  const sprej = item({
    id: "sprejnamedveda-abc",
    source: "sprejnamedveda.sk",
    sourceKey: "sprejnamedveda",
    note: "Medveď pri chatách.",
    lat: 48.7295,
    lng: 18.7602,
    reportedAt: "2026-07-12T12:00:00.000Z",
    datePrecision: "date",
    url: "https://www.sprejnamedveda.sk/medvede-na-mape/",
    sourceLinks: [
      { key: "sprejnamedveda", label: "sprejnamedveda.sk", url: "https://www.sprejnamedveda.sk/medvede-na-mape/", sourceId: "abc" },
    ],
  });

  const merged = dedupeSightings([sprej, mapamedvedov, tumedved]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "tm-1");
  assert.equal(merged[0].reportedAt, tumedved.reportedAt);
  assert.deepEqual(
    merged[0].sourceLinks.map((link) => link.label).sort(),
    ["mapamedvedov.sk", "sprejnamedveda.sk", "tumedved.sk"]
  );
  assert.equal(merged[0].mergedSourceCount, 3);
});

test("nezlúči rovnakú lokalitu v rozdielnych dňoch", () => {
  const nextDay = item({
    id: "mapamedvedov-56",
    source: "mapamedvedov.sk",
    sourceKey: "mapamedvedov",
    reportedAt: "2026-07-13T12:00:00.000Z",
    datePrecision: "date",
    url: "https://mapamedvedov.sk/pozorovanie/56",
    sourceLinks: [
      { key: "mapamedvedov", label: "mapamedvedov.sk", url: "https://mapamedvedov.sk/pozorovanie/56", sourceId: "56" },
    ],
  });

  assert.equal(areSimilarSightings(item(), nextDay), false);
  assert.equal(dedupeSightings([item(), nextDay]).length, 2);
});

test("nezlúči dve vzdialené udalosti v rovnakej obci a deň", () => {
  const first = item({ note: "Jedinec prešiel cez dvor pri severnom okraji mesta." });
  const second = item({
    id: "mapamedvedov-57",
    source: "mapamedvedov.sk",
    sourceKey: "mapamedvedov",
    note: "Stopy našli turisti hlboko v južnej doline pri potoku.",
    lat: 48.88,
    lng: 18.95,
    reportedAt: "2026-07-12T12:00:00.000Z",
    datePrecision: "date",
    url: "https://mapamedvedov.sk/pozorovanie/57",
    sourceLinks: [
      { key: "mapamedvedov", label: "mapamedvedov.sk", url: "https://mapamedvedov.sk/pozorovanie/57", sourceId: "57" },
    ],
  });

  assert.equal(areSimilarSightings(first, second), false);
  assert.equal(dedupeSightings([first, second]).length, 2);
});

test("spoločný odkaz na všeobecnú mapu nespojí rôzne záznamy toho istého zdroja", () => {
  const first = item({
    id: "sprejnamedveda-a",
    source: "sprejnamedveda.sk",
    sourceKey: "sprejnamedveda",
    url: "https://www.sprejnamedveda.sk/medvede-na-mape/",
    sourceLinks: [
      { key: "sprejnamedveda", label: "sprejnamedveda.sk", url: "https://www.sprejnamedveda.sk/medvede-na-mape/", sourceId: "a" },
    ],
  });
  const second = item({
    id: "sprejnamedveda-b",
    source: "sprejnamedveda.sk",
    sourceKey: "sprejnamedveda",
    location: "Liptovská Osada",
    note: "Medvedica pri včelíne na kraji obce.",
    lat: 48.94989,
    lng: 19.28076,
    url: "https://www.sprejnamedveda.sk/medvede-na-mape/",
    sourceLinks: [
      { key: "sprejnamedveda", label: "sprejnamedveda.sk", url: "https://www.sprejnamedveda.sk/medvede-na-mape/", sourceId: "b" },
    ],
  });

  assert.equal(areSimilarSightings(first, second), false);
  assert.equal(dedupeSightings([first, second]).length, 2);
});
