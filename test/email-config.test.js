import assert from "node:assert/strict";
import test from "node:test";

import { readEmailConfig } from "../src/email/config.js";

const configuredEnv = {
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "587",
  SMTP_USER: "alerts@example.test",
  SMTP_PASS: "not-a-real-password",
  EMAIL_FROM: "Alerts <alerts@example.test>",
  NEWSLETTER_TOKEN_SECRET: "a-secure-test-secret-with-more-than-32-characters",
  SITE_URL: "https://example.test/path",
};

test("email remains disabled until every required setting is valid", () => {
  assert.equal(readEmailConfig({}).enabled, false);
  assert.equal(readEmailConfig({ ...configuredEnv, NEWSLETTER_TOKEN_SECRET: "short" }).enabled, false);
  assert.equal(readEmailConfig({ ...configuredEnv, SITE_URL: "http://example.test" }).enabled, false);
  assert.equal(readEmailConfig(configuredEnv).enabled, true);
});

test("SMTP security defaults match the common ports", () => {
  assert.equal(readEmailConfig({ ...configuredEnv, SMTP_PORT: "465" }).secure, true);
  assert.equal(readEmailConfig(configuredEnv).secure, false);
  assert.equal(readEmailConfig(configuredEnv).requireTls, true);
  assert.equal(readEmailConfig({ ...configuredEnv, SMTP_SECURE: "true" }).secure, true);
});
