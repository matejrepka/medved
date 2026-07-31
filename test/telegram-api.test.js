import assert from "node:assert/strict";
import test from "node:test";

import { callTelegramApi, TelegramApiError } from "../src/telegram/api.js";

test("Telegram client uses native JSON fetch and returns the Bot API result", async () => {
  let request;
  const result = await callTelegramApi(
    { botToken: "placeholder" },
    "sendMessage",
    { chat_id: "1", text: "test" },
    async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 9 } }) };
    }
  );
  assert.equal(request.url.endsWith("/sendMessage"), true);
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), { chat_id: "1", text: "test" });
  assert.deepEqual(result, { message_id: 9 });
});

test("Telegram client exposes server retry_after without exposing configuration", async () => {
  await assert.rejects(
    callTelegramApi(
      { botToken: "placeholder" },
      "sendMessage",
      {},
      async () => ({
        ok: false,
        status: 429,
        json: async () => ({ ok: false, description: "Too Many Requests", parameters: { retry_after: 17 } }),
      })
    ),
    (error) => error instanceof TelegramApiError && error.retryAfter === 17
  );
});

