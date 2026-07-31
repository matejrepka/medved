import test from "node:test";
import assert from "node:assert/strict";

import { bearReportToAdminSighting } from "../src/db/repository.js";

test("approved user reports are represented in admin content", () => {
  const record = bearReportToAdminSighting({
    id: 42,
    location: "Bajany, okres Michalovce",
    description: "efefef",
    lat: 48.6,
    lng: 22.1,
    reported_date: "2026-07-31T16:40:00.000Z",
    status: "approved",
    created_at: "2026-07-31T16:41:00.000Z",
    reviewed_at: "2026-07-31T16:42:00.000Z",
  });

  assert.deepEqual(record, {
    id: "report-42",
    entity_type: "bear_report",
    source: "Hlásenie používateľa",
    location: "Bajany, okres Michalovce",
    note: "efefef",
    lat: 48.6,
    lng: 22.1,
    has_coords: true,
    reported_at: "2026-07-31T16:40:00.000Z",
    url: null,
    status: "approved",
    scraped_at: "2026-07-31T16:41:00.000Z",
    updated_at: "2026-07-31T16:42:00.000Z",
  });
});
