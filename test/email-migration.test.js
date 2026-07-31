import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../docs/migration-007-email-notifications.sql", import.meta.url);

test("email migration backfills identities before installing durable delivery", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const backfill = sql.indexOf("insert into public.email_sighting_source_seen");
  const trigger = sql.indexOf("create trigger tumedved_logs_email_notification");
  assert.ok(backfill > 0 && trigger > backfill);
  assert.match(sql, /unique \(subscription_id, dedupe_key\)/i);
  assert.match(sql, /confirmed_at is not null/i);
  assert.match(sql, /for update of outbox skip locked/i);
  assert.equal(sql.match(/\$\$/g)?.length % 2, 0);
});
