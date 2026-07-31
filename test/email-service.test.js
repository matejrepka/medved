import assert from "node:assert/strict";
import test from "node:test";

import { EmailService } from "../src/email/service.js";

const config = {
  enabled: true,
  from: "Alerts <alerts@example.test>",
  replyTo: "contact@example.test",
  siteOrigin: "https://example.test",
  tokenSecret: "a-secure-test-secret-with-more-than-32-characters",
  confirmationTtlSeconds: 3600,
  batchSize: 10,
  pollIntervalMs: 30_000,
};

const subscription = {
  id: 7,
  email: "person@example.test",
  notify_type: "all",
  area_name: null,
  active: true,
  confirmed_at: "2026-07-31T08:00:00Z",
  confirmation_nonce: "nonce-value",
};

test("confirmation delivery contains the signed confirmation link", async () => {
  const messages = [];
  const service = new EmailService({
    config,
    transport: { sendMail: async (message) => { messages.push(message); return { messageId: "confirm-1", rejected: [] }; } },
  });
  await service.sendConfirmation(subscription);
  assert.equal(messages[0].to, subscription.email);
  assert.match(messages[0].html, /\/api\/subscriptions\/confirm\?token=/);
  assert.match(messages[0].subject, /Potvrďte odber/);
});

test("outbox delivery includes unsubscribe headers and is marked sent", async () => {
  const messages = [];
  const marked = [];
  const row = {
    id: 10,
    subscription_id: subscription.id,
    aggregate_type: "tumedved_log",
    attempts: 1,
    payload: { location: "Donovaly", note: "Pri lese", reported_at: "2026-07-31T09:00:00Z" },
  };
  const service = new EmailService({
    config,
    transport: { sendMail: async (message) => { messages.push(message); return { messageId: "warning-1", rejected: [] }; } },
    claim: async () => [row],
    loadSubscription: async () => subscription,
    markSent: async (...args) => marked.push(args),
    cancel: async () => assert.fail("must not cancel"),
    reschedule: async () => assert.fail("must not retry"),
  });
  assert.deepEqual(await service.runAvailable(1), { processed: 1, sent: 1 });
  assert.deepEqual(marked, [[10, "warning-1"]]);
  assert.match(messages[0].headers["List-Unsubscribe"], /unsubscribe\?token=/);
  assert.equal(messages[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.match(messages[0].subject, /Donovaly/);
});

test("inactive subscriptions are cancelled after claim and SMTP failures are retried", async () => {
  const row = { id: 11, subscription_id: 7, attempts: 2, payload: { location: "Martin" } };
  const cancelled = [];
  const inactive = new EmailService({
    config,
    transport: { sendMail: async () => assert.fail("must not send") },
    claim: async () => [row],
    loadSubscription: async () => ({ ...subscription, active: false }),
    cancel: async (id) => cancelled.push(id),
  });
  assert.deepEqual(await inactive.runAvailable(1), { processed: 1, sent: 0 });
  assert.deepEqual(cancelled, [11]);

  const retries = [];
  const failure = new Error("temporary SMTP failure");
  const failing = new EmailService({
    config,
    transport: { sendMail: async () => { throw failure; } },
    claim: async () => [row],
    loadSubscription: async () => subscription,
    reschedule: async (...args) => retries.push(args),
    logger: { error() {} },
  });
  assert.deepEqual(await failing.runAvailable(1), { processed: 1, sent: 0 });
  assert.deepEqual(retries, [[row, failure]]);
});
