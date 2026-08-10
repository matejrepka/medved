import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Telegram migration contains durable dedupe, claiming, triggers and audit RPC", async () => {
  const sql = await readFile(new URL("../docs/migration-005-telegram-notifications.sql", import.meta.url), "utf8");
  assert.match(sql, /dedupe_key text not null unique/i);
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /on conflict \(dedupe_key\) do nothing/i);
  assert.match(sql, /content_moderation_audit/i);
  assert.match(sql, /telegram_moderate_outbox_item/i);
  assert.match(sql, /after insert or update of payload, url, source/i);
  assert.match(sql, /telegram_sighting_source_seen/i);
  assert.match(sql, /returning source_identity into claimed_identity/i);
  assert.match(sql, /new_source_identities/i);
  assert.match(sql, /needs_admin_review/i);
  assert.match(sql, /p_action = 'approved' and exists/i);
  assert.match(sql, /check \(source in \('tumedved', 'sightings', 'news'\)\)/i);
});

test("priority Telegram migration targets website reports ahead of news", async () => {
  const sql = await readFile(new URL("../docs/migration-008-priority-telegram.sql", import.meta.url), "utf8");
  assert.match(sql, /claim_telegram_notification_for_aggregate/i);
  assert.match(sql, /aggregate_type = p_aggregate_type/i);
  assert.match(sql, /aggregate_id = p_aggregate_id/i);
  assert.match(sql, /when event_type = 'pending_public_report' then 0/i);
  assert.match(sql, /payload ->> 'category' = 'warning' then 1/i);
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /grant execute.*service_role/is);
});
