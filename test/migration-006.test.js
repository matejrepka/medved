import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../docs/migration-006-news-incidents.sql", import.meta.url);

test("migration 006 contains durable multi-location storage and balanced functions", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /create table if not exists public\.news_warning_locations/i);
  assert.match(sql, /p_warning_locations jsonb default '\[\]'::jsonb/i);
  assert.equal(sql.match(/\$incident_primary\$/g)?.length, 2);
  assert.equal(sql.match(/\$incident_moderation\$/g)?.length, 2);
  assert.match(sql, /jsonb_array_elements\(coalesce\(p_warning_locations/i);
});
