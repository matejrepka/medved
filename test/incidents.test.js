import test from "node:test";
import assert from "node:assert/strict";

import {
  decideAutomaticIncidentMatch,
  deriveIncidentDateFacts,
  groupNewsByIncidents,
  inferIncidentSourceType,
  rankIncidentSuggestions,
  scoreIncidentMatch,
  selectAutomaticIncidentMatch,
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

test("suggestion ranking excludes unrelated historical incidents", () => {
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

test("nearby coordinates support a locality match", () => {
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

test("automatic matching accepts one exact day and locality match", () => {
  const criteria = {
    eventDate: "2026-07-10",
    locality: "Zvolen",
    title: "Medveď pri priehrade",
  };
  const suggestions = rankIncidentSuggestions([
    { id: "exact", event_date: "2026-07-10", locality: "Zvolen", title: "Medveď pri priehrade" },
    { id: "old", event_date: "2026-06-01", locality: "Zvolen", title: "Staršie pozorovanie" },
  ], criteria);

  assert.equal(selectAutomaticIncidentMatch(suggestions, criteria)?.id, "exact");
});

test("automatic matching refuses two equally strong incident candidates", () => {
  const criteria = { eventDate: "2026-07-10", locality: "Zvolen" };
  const suggestions = rankIncidentSuggestions([
    { id: "one", event_date: "2026-07-10", locality: "Zvolen", title: "Prvé pozorovanie" },
    { id: "two", event_date: "2026-07-10", locality: "Zvolen", title: "Druhé pozorovanie" },
  ], criteria);

  assert.equal(selectAutomaticIncidentMatch(suggestions, criteria), null);
});

test("automatic matching joins a publication-day Turany article to the previous-day incident", () => {
  const criteria = {
    eventDate: "2026-08-09",
    datePrecision: "approximate",
    locality: "Turany",
    lat: 49.1164,
    lng: 19.03915,
    title: "Medveď opäť útočil: 42-ročného muža previezli z Turian do nemocnice s polytraumou",
  };
  const suggestions = rankIncidentSuggestions([{
    id: "turany-attack",
    event_date: "2026-08-08",
    locality: "Turany",
    lat: 49.1164,
    lng: 19.03915,
    title: "Pri zjazde z diaľnice D1 našli zraneného muža po útoku medveďa",
  }], criteria);

  assert.equal(decideAutomaticIncidentMatch(suggestions, criteria).match?.id, "turany-attack");
});

test("automatic matching uses victim details to distinguish nearby weekend attacks", () => {
  const criteria = {
    eventDate: "2026-08-09",
    locality: "Sučany",
    lat: 49.1,
    lng: 18.99,
    title: "Po strete s medveďom neďaleko Martina skončil cyklista v nemocnici",
  };
  const suggestions = rankIncidentSuggestions([
    {
      id: "turany-man",
      event_date: "2026-08-08",
      locality: "Turany",
      lat: 49.1164,
      lng: 19.03915,
      title: "Pri diaľnici našli zraneného 42-ročného muža",
    },
    {
      id: "valca-cyclist",
      event_date: "2026-08-08",
      locality: "Valčianska dolina",
      lat: 49.01,
      lng: 18.83,
      title: "Medveď napadol cyklistu pri Martine a strhol ho z bicykla",
    },
  ], criteria);

  assert.equal(decideAutomaticIncidentMatch(suggestions, criteria).match?.id, "valca-cyclist");
});

test("automatic matching uses a clear distance advantage for neighboring locality names", () => {
  const criteria = {
    eventDate: "2026-08-09",
    locality: "Sučany",
    lat: 49.1,
    lng: 18.99,
    title: "V Sučanoch dohrýzol medveď muža, utrpel úraz hlavy a hrudníka",
  };
  const suggestions = rankIncidentSuggestions([
    {
      id: "turany",
      event_date: "2026-08-08",
      locality: "Turany",
      lat: 49.1164,
      lng: 19.03915,
      title: "Pri zjazde z diaľnice našli zraneného muža po útoku medveďa",
    },
    {
      id: "valca",
      event_date: "2026-08-08",
      locality: "Valčianska dolina",
      lat: 49.01,
      lng: 18.83,
      title: "Medveď napadol cyklistu a strhol ho z bicykla",
    },
  ], criteria);

  assert.equal(decideAutomaticIncidentMatch(suggestions, criteria).match?.id, "turany");
});

test("missing AI event facts fall back to an approximate publication day", () => {
  assert.deepEqual(deriveIncidentDateFacts({
    analysis: {},
    category: "warning",
    publishedAt: "2026-08-09T18:08:46Z",
    scrapedAt: "2026-08-10T02:00:00Z",
  }), {
    eventDate: "2026-08-09",
    precision: "approximate",
    source: "publication",
  });
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

test("public incident card keeps every warning location from associated coverage", () => {
  const result = groupNewsByIncidents({
    articles: [{
      id: "multi",
      source: "Miestne noviny",
      title: "Viacero pozorovaní",
      date: "2026-07-03",
      category: "warning",
      locations: [
        { place: "Važec", lat: 49.06, lng: 19.99 },
        { place: "Východná", lat: 49.06, lng: 19.9 },
      ],
    }],
    incidents: [{
      id: "incident-multi",
      event_date: "2026-07-03",
      locality: "Važec",
      title: "Pozorovania pod Tatrami",
      primary_news_id: "multi",
    }],
    links: [{ incident_id: "incident-multi", news_id: "multi", source_type: "local_original" }],
  });

  assert.deepEqual(result[0].locations.map((location) => location.place), ["Važec", "Východná"]);
  assert.deepEqual(result[0].coverage[0].locations.map((location) => location.place), ["Važec", "Východná"]);
});

test("source inference describes type, not universal authority", () => {
  assert.equal(inferIncidentSourceType({ source: "ŠOP SR" }), "official_notice");
  assert.equal(inferIncidentSourceType({ source: "pozormedved.sk" }), "official_notice");
  assert.equal(inferIncidentSourceType({ source: "TASR" }), "syndication");
  assert.equal(inferIncidentSourceType({ source: "Regionálne noviny" }), "local_original");
});
