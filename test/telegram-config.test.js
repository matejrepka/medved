import assert from "node:assert/strict";
import test from "node:test";

import { isAllowedPrivateCallback, readTelegramConfig } from "../src/telegram/config.js";
import { parseModerationCallback, webhookSecretMatches } from "../src/telegram/service.js";

const configuredEnv = {
  TELEGRAM_BOT_TOKEN: "not-a-real-token",
  TELEGRAM_CHAT_ID: "12345",
  TELEGRAM_ALLOWED_CHAT_IDS: "12345,67890,-1000,invalid",
  TELEGRAM_WEBHOOK_SECRET: "valid_webhook_secret_123",
  SITE_URL: "https://example.test/path",
};

test("Telegram remains disabled until every required setting is valid", () => {
  assert.equal(readTelegramConfig({}).enabled, false);
  assert.equal(readTelegramConfig({ ...configuredEnv, TELEGRAM_CHAT_ID: "-100" }).enabled, false);
  assert.equal(readTelegramConfig({ ...configuredEnv, SITE_URL: "http://example.test" }).enabled, false);
  assert.equal(readTelegramConfig({ ...configuredEnv, TELEGRAM_WEBHOOK_SECRET: "short" }).enabled, false);
  assert.equal(readTelegramConfig(configuredEnv).enabled, true);
});

test("moderation accepts only explicitly allowed private chats", () => {
  const config = readTelegramConfig(configuredEnv);
  assert.equal(isAllowedPrivateCallback(config, { message: { chat: { id: 67890, type: "private" } } }), true);
  assert.equal(isAllowedPrivateCallback(config, { message: { chat: { id: 99999, type: "private" } } }), false);
  assert.equal(isAllowedPrivateCallback(config, { message: { chat: { id: 12345, type: "group" } } }), false);
});

test("callback payload and webhook secret parsing reject malformed input", () => {
  assert.deepEqual(parseModerationCallback("tm:c:42"), { action: "c", outboxId: 42 });
  assert.equal(parseModerationCallback("tm:c:-1"), null);
  assert.equal(parseModerationCallback("other:a:42"), null);
  assert.equal(webhookSecretMatches("same-secret", "same-secret"), true);
  assert.equal(webhookSecretMatches("same-secret", "different-secret"), false);
  assert.equal(webhookSecretMatches("", ""), false);
});
