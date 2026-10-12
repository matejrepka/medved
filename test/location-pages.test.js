import test from "node:test";
import assert from "node:assert/strict";

import { createLocationRecordMatcher, mergeLocationPages } from "../src/location-pages.js";

test("location indexing retains phrase boundaries, accents, fields and source order", () => {
  const normalize = value => String(value || "").toLocaleLowerCase("sk").normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const items = [
    { id: "a", title: "Medveď v Banskej Bystrici", place: "Banská Bystrica" },
    { id: "b", title: "Upozornenie", locations: [{place:"Banska Bystrica"}, {place:"Žiar nad Hronom"}] },
    { id: "c", place: "Banská", title: "Bystrica" },
    { id: "d", snippet: "Bystrica a Banská Bystrica" },
    { id: "e", title: "Banská Bystrica2" },
  ];
  const match = createLocationRecordMatcher(items, "news", normalize);
  assert.deepEqual(match("Banská Bystrica").map(item=>item.id), ["a","b","d"]);
  assert.deepEqual(match("ziar nad hronom").map(item=>item.id), ["b"]);
  assert.deepEqual(match(""), []);
  const warning = createLocationRecordMatcher([{id:"w",location:"Žiar nad Hronom - okolie",note:"Banská Bystrica"}], "warning", normalize);
  assert.deepEqual(warning("Žiar nad Hronom").map(item=>item.id), ["w"]);
  assert.deepEqual(warning("Banská Bystrica"), []);
});

test("mergeLocationPages zlúči rovnaký slug, odstráni duplicitné záznamy a zachová diakritiku", () => {
  const sharedWarning = {
    id: "warning-1",
    location: "Podbanské",
    reportedAt: "2026-07-10T08:00:00Z",
  };
  const pages = mergeLocationPages([
    {
      name: "Podbanske",
      slug: "podbanske",
      path: "/vyskyt-medveda/podbanske",
      lat: null,
      lng: null,
      warningItems: [sharedWarning],
      newsItems: [],
      latest: sharedWarning.reportedAt,
    },
    {
      name: "Podbanské",
      slug: "podbanske",
      path: "/vyskyt-medveda/podbanske",
      lat: 49.14,
      lng: 19.9,
      warningItems: [sharedWarning],
      newsItems: [
        {
          id: "news-1",
          title: "Upozornenie pri Podbanskom",
          date: "2026-07-12T10:00:00Z",
        },
      ],
      latest: "2026-07-12T10:00:00Z",
    },
  ]);

  assert.equal(pages.length, 1);
  assert.equal(pages[0].name, "Podbanské");
  assert.equal(pages[0].sightings, 1);
  assert.equal(pages[0].news, 1);
  assert.equal(pages[0].total, 2);
  assert.equal(pages[0].lat, 49.14);
  assert.equal(pages[0].first, "2026-07-10T08:00:00Z");
  assert.equal(pages[0].latest, "2026-07-12T10:00:00Z");
});

test("mergeLocationPages zoradí stránky podľa počtu jedinečných záznamov", () => {
  const pages = mergeLocationPages([
    {
      name: "Brezno",
      slug: "brezno",
      path: "/vyskyt-medveda/brezno",
      warningItems: [{ id: "b-1", reportedAt: "2026-07-01" }],
      newsItems: [],
    },
    {
      name: "Zvolen",
      slug: "zvolen",
      path: "/vyskyt-medveda/zvolen",
      warningItems: [
        { id: "z-1", reportedAt: "2026-07-01" },
        { id: "z-2", reportedAt: "2026-07-02" },
      ],
      newsItems: [],
    },
  ]);

  assert.deepEqual(pages.map((page) => page.slug), ["zvolen", "brezno"]);
});
