import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../docs/migration-009-email-digests.sql", import.meta.url);

test("digest migration queues news and claims complete subscriber batches", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /'news_warning', 'news_article'/i);
  assert.match(sql, /'news_log'/i);
  assert.match(sql, /create trigger news_logs_email_notification/i);
  assert.match(sql, /group by outbox\.subscription_id/i);
  assert.match(sql, /join subscriber_candidates selected/i);
  assert.match(sql, /for update of outbox skip locked/i);
  assert.equal(sql.match(/\$\$/g)?.length % 2, 0);
});
