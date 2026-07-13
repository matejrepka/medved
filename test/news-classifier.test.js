import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyFreshNews,
  parseClassificationResponse,
} from "../src/ai/news-classifier.js";

test("parseClassificationResponse validates and normalizes model JSON", () => {
  const results = parseClassificationResponse(
    '```json\n{"results":[{"index":0,"category":"warning","place":"  Morské oko  ","confidence":1.4},{"index":1,"category":"article","place":"Bratislava","confidence":0.8}]}\n```',
    2
  );

  assert.deepEqual(results.get(0), {
    category: "warning",
    place: "Morské oko",
    confidence: 1,
  });
  assert.deepEqual(results.get(1), {
    category: "article",
    place: null,
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
                  { index: 0, category: "warning", place: "Morské oko", confidence: 0.98 },
                  { index: 1, category: "article", place: null, confidence: 0.91 },
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
  assert.equal(items[0].lat, 48.9150886);
  assert.equal(items[0].hasCoords, true);
  assert.equal(items[1].category, "article");
  assert.equal(items[1].place, null);
  assert.equal(items[1].lat, null);
  assert.equal(items[1].lng, null);
  assert.equal(items[1].hasCoords, false);
});

test("classifyFreshNews leaves items unchanged when API key is missing", async () => {
  const items = [{ title: "Správa", place: "Brezno", category: undefined }];
  await classifyFreshNews(items, { apiKey: "" });
  assert.equal(items[0].place, "Brezno");
  assert.equal(items[0].category, undefined);
});
