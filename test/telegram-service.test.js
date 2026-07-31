import assert from "node:assert/strict";
import test from "node:test";

import { TelegramService } from "../src/telegram/service.js";

const config = {
  enabled: true,
  botToken: "not-a-real-token",
  chatId: "12345",
  webhookSecret: "valid_webhook_secret_123",
  siteOrigin: "https://example.test",
  allowedChatIds: new Set(["12345"]),
  batchSize: 10,
  pollIntervalMs: 30_000,
};

function callback(data, overrides = {}) {
  return {
    callback_query: {
      id: "callback-1",
      data,
      from: { id: 5, username: "moderator" },
      message: {
        message_id: 77,
        text: "Original card",
        chat: { id: 12345, type: "private" },
      },
      ...overrides,
    },
  };
}

test("worker marks successful deliveries sent", async () => {
  const sent = [];
  const service = new TelegramService({
    config,
    claim: async () => [{
      id: 1,
      event_type: "pending_public_report",
      aggregate_type: "bear_report",
      attempts: 1,
      payload: { location: "Martin", reported_date: "2026-07-31T10:00:00Z" },
    }],
    api: async (_config, method) => {
      assert.equal(method, "sendMessage");
      return { message_id: 55 };
    },
    markSent: async (...args) => sent.push(args),
    reschedule: async () => assert.fail("must not retry"),
  });
  assert.deepEqual(await service.runOnce(), { processed: 1, sent: 1 });
  assert.deepEqual(sent, [[1, 55]]);
});

test("worker reschedules a failed delivery without losing the row", async () => {
  const retried = [];
  const failure = Object.assign(new Error("temporary"), { retryAfter: 12 });
  const row = {
    id: 2,
    event_type: "admin_warning",
    aggregate_type: "bear_report",
    attempts: 2,
    payload: { location: "Martin", reported_date: "2026-07-31T10:00:00Z" },
  };
  const service = new TelegramService({
    config,
    claim: async () => [row],
    api: async () => { throw failure; },
    markSent: async () => assert.fail("must not mark sent"),
    reschedule: async (...args) => retried.push(args),
    logger: { error() {} },
  });
  assert.deepEqual(await service.runOnce(), { processed: 1, sent: 0 });
  assert.deepEqual(retried, [[row, failure, 12]]);
});

test("bounded drain processes multiple batches for an ephemeral request", async () => {
  let claims = 0;
  const delivered = [];
  const row = (id) => ({
    id,
    event_type: "admin_warning",
    aggregate_type: "bear_report",
    attempts: 1,
    payload: { location: "Martin", reported_date: "2026-07-31T10:00:00Z" },
  });
  const service = new TelegramService({
    config: { ...config, batchSize: 2 },
    claim: async () => {
      claims += 1;
      return claims === 1 ? [row(1), row(2)] : claims === 2 ? [row(3)] : [];
    },
    api: async () => ({ message_id: 99 }),
    markSent: async (id) => delivered.push(id),
    reschedule: async () => assert.fail("must not retry"),
  });
  assert.deepEqual(await service.runAvailable(3), { processed: 3, sent: 3 });
  assert.deepEqual(delivered, [1, 2, 3]);
  assert.equal(claims, 2);
});

test("reject requires confirmation before transactional moderation", async () => {
  const methods = [];
  let moderationCalls = 0;
  const service = new TelegramService({
    config,
    api: async (_config, method, body) => {
      methods.push([method, body]);
      return true;
    },
    moderate: async ({ action }) => {
      moderationCalls += 1;
      return { changed: true, status: action };
    },
  });

  const first = await service.handleUpdate(callback("tm:r:15"));
  assert.equal(first.confirmation, true);
  assert.equal(moderationCalls, 0);
  assert.equal(methods[0][0], "editMessageReplyMarkup");
  assert.equal(methods[0][1].reply_markup.inline_keyboard[0][0].callback_data, "tm:c:15");

  const confirmed = await service.handleUpdate(callback("tm:c:15"));
  assert.equal(confirmed.status, "rejected");
  assert.equal(moderationCalls, 1);
});

test("callback from a group or unknown private chat cannot moderate", async () => {
  let moderationCalls = 0;
  const service = new TelegramService({
    config,
    api: async () => true,
    moderate: async () => { moderationCalls += 1; },
  });
  const result = await service.handleUpdate(callback("tm:a:15", {
    message: { message_id: 1, chat: { id: 12345, type: "group" } },
  }));
  assert.equal(result.authorized, false);
  assert.equal(moderationCalls, 0);
});

test("warning without verified coordinates remains pending for admin review", async () => {
  const methods = [];
  const service = new TelegramService({
    config,
    api: async (_config, method, body) => {
      methods.push([method, body]);
      return true;
    },
    moderate: async () => ({
      changed: false,
      status: "pending",
      outcome: "needs_admin_review",
    }),
  });
  const result = await service.handleUpdate(callback("tm:a:15"));
  assert.equal(result.needsAdminReview, true);
  assert.equal(result.status, "pending");
  assert.deepEqual(methods.map(([method]) => method), ["answerCallbackQuery"]);
  assert.equal(methods[0][1].show_alert, true);
});

test("unexpected moderation RPC outcome is not mislabelled as rejection", async () => {
  const service = new TelegramService({
    config,
    api: async () => true,
    moderate: async () => ({ changed: false, status: "pending" }),
  });
  await assert.rejects(
    service.handleUpdate(callback("tm:a:15")),
    /unsupported outcome/
  );
});
