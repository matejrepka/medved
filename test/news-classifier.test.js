import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyFreshNews,
  parseClassificationResponse,
} from "../src/ai/news-classifier.js";
import { geocodeNews } from "../src/geo/geocode.js";

test("parseClassificationResponse validates and normalizes model JSON", () => {
  const results = parseClassificationResponse(
    '```json\n{"results":[{"index":0,"category":"warning","place":"  Morské oko  ","confidence":1.4},{"index":1,"category":"article","place":"Bratislava","confidence":0.8}]}\n```',
    2
  );

  assert.deepEqual(results.get(0), {
    category: "warning",
    place: "Morské oko",
    places: ["Morské oko"],
    summary: "",
    eventDate: null,
    eventDatePrecision: "unknown",
    eventDateConfidence: null,
    confidence: 1,
  });
  assert.deepEqual(results.get(1), {
    category: "article",
    place: null,
    places: [],
    summary: "",
    eventDate: null,
    eventDatePrecision: "unknown",
    eventDateConfidence: null,
    confidence: 0.8,
  });
});

test("classifyFreshNews prefills warning location and clears article coordinates", async () => {
  const items = [
    {
      title: "Medveď pri Morskom oku",
      place: "Remetské Hámre",
      lat: 48.8,
      lng: 22.1,
      hasCoords: true,
    },
    {
      title: "Ako sa správať v lese",
      place: "Žilina",
      lat: 49.2,
      lng: 18.7,
      hasCoords: true,
    },
  ];

  let requestedModel;
  const fetchImpl = async (_url, options) => {
    requestedModel = JSON.parse(options.body).model;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                results: [
                  { index: 0, category: "warning", place: "Morské oko", summary: "Pri Morskom oku zaznamenali medveďa.", confidence: 0.98 },
                  { index: 1, category: "article", place: null, summary: "Článok vysvetľuje zásady bezpečného pohybu v lese.", confidence: 0.91 },
                ],
              }),
            },
          },
        ],
      }),
    };
  };

  await classifyFreshNews(items, {
    apiKey: "test-key",
    fetchImpl,
    resolveLocation: async (name) => ({ name, lat: 48.9150886, lng: 22.1978148 }),
  });

  assert.equal(requestedModel, "openrouter/free");
  assert.equal(items[0].category, "warning");
  assert.equal(items[0].place, "Morské oko");
  assert.deepEqual(items[0].locations, [{
    place: "Morské oko",
    lat: 48.9150886,
    lng: 22.1978148,
    hasCoords: true,
  }]);
  assert.equal(items[0].lat, 48.9150886);
  assert.equal(items[0].hasCoords, true);
  assert.equal(items[0].aiSummary, "Pri Morskom oku zaznamenali medveďa.");
  assert.equal(items[0].aiClassification.summaryGenerated, true);
  assert.equal(items[1].category, "article");
  assert.equal(items[1].place, null);
  assert.deepEqual(items[1].locations, []);
  assert.equal(items[1].lat, null);
  assert.equal(items[1].lng, null);
  assert.equal(items[1].hasCoords, false);
  assert.equal(items[1].aiSummary, "Článok vysvetľuje zásady bezpečného pohybu v lese.");
});

test("classifyFreshNews extracts and geocodes every concrete warning location", async () => {
  const items = [{ title: "Medvede videli pri Važci aj vo Východnej" }];
  const coordinates = {
    Važec: [49.06, 19.99],
    Východná: [49.06, 19.9],
  };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            results: [{
              index: 0,
              category: "warning",
              places: ["Važec", "Východná", "Važec"],
              eventDate: "2026-07-30",
              eventDatePrecision: "day",
              eventDateConfidence: 0.94,
              confidence: 0.97,
            }],
          }),
        },
      }],
    }),
  });

  await classifyFreshNews(items, {
    apiKey: "test-key",
    fetchImpl,
    resolveLocation: async (name) => ({
      name,
      lat: coordinates[name][0],
      lng: coordinates[name][1],
    }),
  });

  assert.equal(items[0].place, "Važec");
  assert.deepEqual(items[0].locations.map((location) => location.place), ["Važec", "Východná"]);
  assert.equal(items[0].locations.every((location) => location.hasCoords), true);
  assert.deepEqual(items[0].aiClassification.places, ["Važec", "Východná"]);
  assert.equal(items[0].aiClassification.eventDate, "2026-07-30");
  assert.equal(items[0].aiClassification.eventDatePrecision, "day");
  assert.equal(items[0].aiClassification.eventDateConfidence, 0.94);
});

test("classifyFreshNews leaves items unchanged when API key is missing", async () => {
  const items = [{ title: "Správa", place: "Brezno", category: undefined }];
  await classifyFreshNews(items, { apiKey: "" });
  assert.equal(items[0].place, "Brezno");
  assert.equal(items[0].category, undefined);
});

test("classifyFreshNews keeps an explicit municipal bear warning out of articles", async () => {
  const items = await geocodeNews([
    {
      title: "Útek pred mega medveďom na východe Slovenska",
      snippet:
        "V okolí obcí Hozelec a Gánovce upozorňujú na výskyt medveďa.",
    },
  ]);
  const geocodedLat = items[0].lat;

  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              results: [
                { index: 0, category: "article", place: null, confidence: 0.9 },
              ],
            }),
          },
        },
      ],
    }),
  });

  await classifyFreshNews(items, { apiKey: "test-key", fetchImpl });

  assert.equal(items[0].category, "warning");
  assert.equal(items[0].place, "Hozelec");
  assert.equal(items[0].lat, geocodedLat);
  assert.equal(items[0].hasCoords, true);
  assert.equal(items[0].aiClassification.rule, "explicit-local-warning");
});
