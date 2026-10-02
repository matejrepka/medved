import assert from "node:assert/strict";
import test from "node:test";
import { basicAdminMatches, createAttemptLimiter, secretMatches, validatePublicReport } from "../src/security.js";

test("admin passwords preserve colons and UTF-8 and require the Basic scheme", () => {
  const password = "čučoriedka:secret:123";
  const credentials = Buffer.from(`admin:${password}`).toString("base64");
  assert.equal(basicAdminMatches(`Basic ${credentials}`, password), true);
  assert.equal(basicAdminMatches(`Bearer ${credentials}`, password), false);
  assert.equal(basicAdminMatches(`Basic ${credentials}`, "wrong"), false);
  assert.equal(secretMatches("", ""), false);
  assert.equal(secretMatches("secret", ["secret"]), false);
});

test("rate limits cap repeated attempts and memory, and expire", () => {
  let now = 0;
  const limiter = createAttemptLimiter({ limit: 2, maxKeys: 2, windowMs: 100, now: () => now });
  assert.equal(limiter.consume("a"), false);
  assert.equal(limiter.consume("a"), false);
  for (let i = 0; i < 1000; i++) assert.equal(limiter.consume("a"), true);
  assert.equal(limiter.consume("b"), false);
  assert.equal(limiter.consume("c"), true);
  now = 100;
  assert.equal(limiter.consume("c"), false);
  assert.equal(limiter.consume("a"), false);
});

test("reports reject malformed types, excessive text, invalid email, date and coordinates", () => {
  const now = Date.parse("2026-10-02T10:00:00Z");
  const base = { location: " Turany ", lat: 49.1, lng: 19.03 };
  assert.equal(validatePublicReport(base, now).report.location, "Turany");
  assert.equal(validatePublicReport({ location: "Turany" }, now).report.lat, null);
  for (const fields of [
    { location: "a".repeat(201) }, { description: {} }, { reporterName: [] },
    { description: "a".repeat(2001) }, { reporterEmail: "a@b.sk,attacker@c.sk" },
    { reportedDate: "invalid" }, { reportedDate: "2027-01-01" },
    { lat: 0, lng: 0 }, { lat: 49.1, lng: null }, { lat: [], lng: 19 },
  ]) assert.ok(validatePublicReport({ ...base, ...fields }, now).error, JSON.stringify(fields));
});
