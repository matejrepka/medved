import assert from "node:assert/strict";
import test from "node:test";

import { createEmailToken, verifyEmailToken } from "../src/email/tokens.js";

const secret = "a-secure-test-secret-with-more-than-32-characters";
const subscription = {
  id: 42,
  email: "Person@Example.test",
  confirmation_nonce: "nonce-value",
};

test("confirmation tokens are signed, scoped, and expire", () => {
  const token = createEmailToken({
    subscription,
    purpose: "confirm",
    secret,
    ttlSeconds: 60,
    now: 1_000_000,
  });
  assert.deepEqual(verifyEmailToken(token, { purpose: "confirm", secret, now: 1_030_000 }), {
    id: 42,
    email: "person@example.test",
    nonce: "nonce-value",
  });
  assert.equal(verifyEmailToken(token, { purpose: "unsubscribe", secret, now: 1_030_000 }), null);
  assert.equal(verifyEmailToken(token, { purpose: "confirm", secret, now: 1_061_000 }), null);
  assert.equal(verifyEmailToken(`${token}x`, { purpose: "confirm", secret, now: 1_030_000 }), null);
});

test("unsubscribe tokens remain valid until the subscription nonce changes", () => {
  const token = createEmailToken({ subscription, purpose: "unsubscribe", secret });
  assert.equal(verifyEmailToken(token, { purpose: "unsubscribe", secret })?.id, 42);
});
