import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyReportSpam,
  parseReportSpamResponse,
  shouldAutoApproveReport,
} from "../src/ai/report-spam-classifier.js";

test("parseReportSpamResponse validates and normalizes model JSON", () => {
  assert.deepEqual(
    parseReportSpamResponse(
      '```json\n{"verdict":"legitimate","confidence":1.4,"reason":" Krátke hlásenie "}\n```'
    ),
    { verdict: "legitimate", confidence: 1, reason: "Krátke hlásenie" }
  );
  assert.throws(() => parseReportSpamResponse('{"verdict":"unknown","confidence":0.9}'));
});

test("only high-confidence legitimate reports bypass moderation", () => {
  assert.equal(shouldAutoApproveReport({ verdict: "legitimate", confidence: 0.8 }), true);
  assert.equal(shouldAutoApproveReport({ verdict: "legitimate", confidence: 0.79 }), false);
  assert.equal(shouldAutoApproveReport({ verdict: "spam", confidence: 0.99 }), false);
  assert.equal(shouldAutoApproveReport({ verdict: "review", confidence: null }), false);
});

test("classifyReportSpam sends no reporter contact details", async () => {
  let requestBody;
  const result = await classifyReportSpam(
    {
      location: "Liptovský Mikuláš",
      description: "Medveď pri lese",
      reporterName: "Citlivé meno",
      reporterEmail: "secret@example.com",
    },
    {
      apiKey: "test-key",
      fetchImpl: async (_url, options) => {
        requestBody = options.body;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: '{"verdict":"legitimate","confidence":0.96,"reason":"Hlásenie"}' } }],
          }),
        };
      },
    }
  );

  assert.equal(result.verdict, "legitimate");
  assert.doesNotMatch(requestBody, /Citlivé meno|secret@example\.com/);
  assert.match(requestBody, /Liptovský Mikuláš/);
});

test("classifier failure falls back to human review", async () => {
  const result = await classifyReportSpam(
    { location: "Brezno", description: "Pozorovanie" },
    {
      apiKey: "test-key",
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    }
  );

  assert.equal(result.verdict, "review");
  assert.equal(shouldAutoApproveReport(result), false);
});
