import assert from "node:assert/strict";
import test from "node:test";

import { EmailService } from "../src/email/service.js";

const config = {
  enabled: true,
  from: "Alerts <alerts@example.test>",
  replyTo: "contact@example.test",
  feedbackTo: "owner@example.test",
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

test("feedback is sent to the owner and uses the visitor address for replies", async () => {
  const messages = [];
  const service = new EmailService({
    config,
    transport: { sendMail: async (message) => { messages.push(message); return { messageId: "feedback-1", rejected: [] }; } },
  });
  await service.sendFeedback({
    kind: "message",
    message: "Prosím pridajte filter podľa okresu.",
    email: "visitor@example.test",
    receivedAt: "2026-09-14T10:00:00Z",
  });
  assert.equal(messages[0].to, "owner@example.test");
  assert.equal(messages[0].replyTo, "visitor@example.test");
  assert.match(messages[0].subject, /Spätná väzba/);
  assert.match(messages[0].text, /filter podľa okresu/);
});

test("outbox rows for one subscriber are combined into one digest", async () => {
  const messages = [];
  const marked = [];
  const warning = {
    id: 10,
    subscription_id: subscription.id,
    aggregate_type: "tumedved_log",
    attempts: 1,
    payload: { location: "Donovaly", note: "Pri lese", reported_at: "2026-07-31T09:00:00Z" },
  };
  const news = {
    id: 11,
    subscription_id: subscription.id,
    event_type: "news_article",
    aggregate_type: "news_log",
    attempts: 1,
    payload: {
      category: "article",
      title: "Nové pravidlá ochrany prírody",
      summary: "Krátky súhrn správy.",
      source: "Denník",
      article_url: "https://news.example.test/article",
      published_at: "2026-07-31T10:00:00Z",
    },
  };
  const service = new EmailService({
    config,
    transport: { sendMail: async (message) => { messages.push(message); return { messageId: "warning-1", rejected: [] }; } },
    claim: async () => [warning, news],
    loadSubscription: async () => subscription,
    markSent: async (...args) => marked.push(args),
    cancel: async () => assert.fail("must not cancel"),
    reschedule: async () => assert.fail("must not retry"),
  });
  assert.deepEqual(await service.runAvailable(1), { processed: 2, sent: 1 });
  assert.deepEqual(marked, [[[warning, news], "warning-1"]]);
  assert.equal(messages.length, 1);
  assert.match(messages[0].headers["List-Unsubscribe"], /unsubscribe\?token=/);
  assert.equal(messages[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.match(messages[0].subject, /1 varovaní, 1 správ/);
  assert.match(messages[0].html, /Varovania/);
  assert.match(messages[0].html, /Správy/);
  assert.match(messages[0].html, /Donovaly/);
  assert.match(messages[0].html, /Nové pravidlá ochrany prírody/);
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
  assert.deepEqual(cancelled, [[row]]);

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
  assert.deepEqual(retries, [[[row], failure]]);
});

test("scheduled delivery runs once at 06:00, 12:00 and 18:00 Bratislava time", async () => {
  let claims = 0;
  const service = new EmailService({
    config: { ...config, digestHours: [6, 12, 18], digestTimeZone: "Europe/Bratislava", digestWindowMinutes: 15 },
    transport: { sendMail: async () => assert.fail("empty outbox must not send") },
    claim: async () => { claims += 1; return []; },
  });

  assert.deepEqual(await service.runScheduled(new Date("2026-07-31T03:59:00Z")), { processed: 0, sent: 0, scheduled: false });
  assert.deepEqual(await service.runScheduled(new Date("2026-07-31T04:00:00Z")), { processed: 0, sent: 0 });
  assert.deepEqual(await service.runScheduled(new Date("2026-07-31T04:05:00Z")), { processed: 0, sent: 0, scheduled: false });
  assert.deepEqual(await service.runScheduled(new Date("2026-07-31T10:00:00Z")), { processed: 0, sent: 0 });
  assert.deepEqual(await service.runScheduled(new Date("2026-07-31T16:00:00Z")), { processed: 0, sent: 0 });
  assert.equal(claims, 3);
});
