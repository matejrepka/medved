import test from "node:test";
import assert from "node:assert/strict";

import {
  historicalEventFacts,
  selectApproximateHistoricalMatch,
  selectUndatedHistoricalMatch,
} from "../scripts/backfill-news-incidents.mjs";

test("historical backfill prefers a reliable exact AI event date", () => {
  assert.deepEqual(
    historicalEventFacts(
      { published_at: "2026-07-14T09:00:00Z" },
      {
        category: "warning",
        eventDate: "2026-07-12",
        eventDatePrecision: "day",
        eventDateConfidence: 0.91,
      }
    ),
    { eventDate: "2026-07-12", precision: "day", source: "ai" }
  );
});

test("historical backfill marks publication-date fallback as approximate", () => {
  assert.deepEqual(
    historicalEventFacts(
      { published_at: "2026-07-14T09:00:00Z" },
      { category: "warning", eventDateConfidence: 0.4 }
    ),
    { eventDate: "2026-07-14", precision: "approximate", source: "publication" }
  );
});

test("historical backfill accepts a legacy row with null AI analysis", () => {
  assert.deepEqual(
    historicalEventFacts({ published_at: "2026-07-14T09:00:00Z" }, null),
    { eventDate: "2026-07-14", precision: "approximate", source: "publication" }
  );
});

test("historical backfill uses first-seen date only as an approximate last resort", () => {
  assert.deepEqual(
    historicalEventFacts({ scraped_at: "2026-07-20T04:00:54Z" }, null),
    { eventDate: "2026-07-20", precision: "approximate", source: "scrape" }
  );
});

test("approximate matching requires date, locality, and content agreement", () => {
  const criteria = {
    eventDate: "2026-07-12",
    locality: "Závažná Poruba",
    title: "Medveď napadol muža pred domom v Závažnej Porube",
  };
  const related = {
    id: "related",
    event_date: "2026-07-12",
    locality: "Závažná Poruba",
    title: "V Závažnej Porube zaútočil medveď na muža pred domom",
  };
  const unrelated = {
    id: "unrelated",
    event_date: "2026-07-12",
    locality: "Závažná Poruba",
    title: "Obec opravila cestu a otvorila kultúrne centrum",
  };

  assert.equal(selectApproximateHistoricalMatch([related], criteria)?.id, "related");
  assert.equal(selectApproximateHistoricalMatch([unrelated], criteria), null);
});

test("undated matching accepts one strong locality match but rejects ambiguity", () => {
  const criteria = {
    locality: "Pitelová",
    lat: 48.58,
    lng: 18.92,
    title: "Do obce sa zatúlal medveď",
  };
  const match = {
    id: "match",
    event_date: "2026-07-18",
    locality: "Pitelová",
    lat: 48.58,
    lng: 18.92,
    title: "Upozornenie na medveďa v obci Pitelová",
  };
  assert.equal(selectUndatedHistoricalMatch([match], criteria)?.id, "match");
  assert.equal(selectUndatedHistoricalMatch([match, { ...match, id: "other" }], criteria), null);
});
