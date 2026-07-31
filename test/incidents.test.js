import test from "node:test";
import assert from "node:assert/strict";

import {
  groupNewsByIncidents,
  inferIncidentSourceType,
  rankIncidentSuggestions,
  scoreIncidentMatch,
} from "../src/incidents.js";

test("incident suggestions use event date instead of article publication date", () => {
  const incident = {
    id: "i-1",
    event_date: "2026-07-01",
    locality: "Liptovský Mikuláš",
    title: "Medveď pri sídlisku Podbreziny",
  };
  const match = scoreIncidentMatch(incident, {
    eventDate: "2026-07-01",
    locality: "Liptovský Mikuláš",
    title: "O incidente informovali o dva týždne neskôr",
    publishedAt: "2026-07-15T08:00:00Z",
  });
  assert.equal(match.dateDistanceDays, 0);
  assert.ok(match.score >= 80);
});

test("uncertain candidates are ranked but never merged by the matcher", () => {
  const incidents = [
    { id: "near", event_date: "2026-07-10", locality: "Zvolen", title: "Pozorovanie pri priehrade" },
    { id: "far", event_date: "2025-02-10", locality: "Poprad", title: "Medveď v lese" },
  ];
  const suggestions = rankIncidentSuggestions(incidents, {
    eventDate: "2026-07-10",
    locality: "Zvolen",
    title: "Medveď pri priehrade",
  });
  assert.equal(suggestions[0].id, "near");
  assert.equal(suggestions.some((item) => item.id === "far"), false);
  assert.equal(incidents[0].incident_id, undefined);
});

test("nearby coordinates support a locality match without deciding it automatically", () => {
  const incident = {
    id: "nearby",
    event_date: "2026-07-10",
    locality: "Liptovský Mikuláš",
    lat: 49.0833,
    lng: 19.6167,
    title: "Výskyt pri sídlisku",
  };
  const match = scoreIncidentMatch(incident, {
    eventDate: "2026-07-10",
    locality: "Podbreziny",
    lat: 49.086,
    lng: 19.62,
    title: "Medveď pri sídlisku",
  });
  assert.ok(match.distanceKm < 2);
  assert.ok(match.reasons.some((reason) => reason.includes("vzdialenosť")));
  assert.equal(incident.news_id, undefined);
});

test("public grouping keeps all article coverage and promotes stronger source", () => {
  const articles = [
    { id: "national", source: "Celoštátne médium", title: "Správa", date: "2026-07-03", articleUrl: "https://news.test/national", category: "article" },
    { id: "official", source: "ŠOP SR", title: "Oznámenie", date: "2026-07-05", articleUrl: "https://sopsr.sk/notice", category: "warning" },
  ];
  const result = groupNewsByIncidents({
    articles,
    incidents: [{
      id: "incident-1",
      event_date: "2026-07-01",
      locality: "Zvolen",
      title: "Výskyt medveďa pri Zvolene",
      primary_news_id: "official",
      verification_status: "official_notice",
    }],
    links: [
      { incident_id: "incident-1", news_id: "national", source_type: "national" },
      { incident_id: "incident-1", news_id: "official", source_type: "official_notice" },
    ],
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].sourceCount, 2);
  assert.equal(result[0].articleUrl, "https://sopsr.sk/notice");
  assert.deepEqual(result[0].coverage.map((item) => item.id), ["official", "national"]);
  assert.equal(result[0].category, "warning");
});

test("source inference describes type, not universal authority", () => {
  assert.equal(inferIncidentSourceType({ source: "ŠOP SR" }), "official_notice");
  assert.equal(inferIncidentSourceType({ source: "TASR" }), "syndication");
  assert.equal(inferIncidentSourceType({ source: "Regionálne noviny" }), "local_original");
});
