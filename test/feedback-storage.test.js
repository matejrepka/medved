import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../docs/migration-010-feedback-submissions.sql", import.meta.url);
const serverUrl = new URL("../server.js", import.meta.url);
const adminUrl = new URL("../public/admin.html", import.meta.url);

test("feedback migration stores messages and constrained poll responses privately", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create table if not exists public\.feedback_submissions/i);
  assert.match(sql, /kind in \('message', 'newsletter_poll'\)/i);
  assert.match(sql, /email_status in \('pending', 'sent', 'failed', 'disabled'\)/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all.+anon, authenticated/is);
});

test("feedback is persisted and available from the authenticated admin API", async () => {
  const [server, admin] = await Promise.all([
    readFile(serverUrl, "utf8"),
    readFile(adminUrl, "utf8"),
  ]);
  assert.match(server, /saveFeedbackSubmission\(/);
  assert.match(server, /app\.get\("\/api\/admin\/feedback", adminAuth/);
  assert.match(admin, /data-tab="feedback"/);
  assert.match(admin, /authFetch\('\/api\/admin\/feedback'\)/);
});
