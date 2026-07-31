export class TelegramApiError extends Error {
  constructor(message, { retryAfter = null, status = null } = {}) {
    super(message);
    this.name = "TelegramApiError";
    this.retryAfter = retryAfter;
    this.status = status;
  }
}

export async function callTelegramApi(config, method, body, fetchImpl = fetch) {
  const response = await fetchImpl(
    `https://api.telegram.org/bot${config.botToken}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }
  );

  let result;
  try {
    result = await response.json();
  } catch {
    throw new TelegramApiError(`Telegram returned HTTP ${response.status}`, {
      status: response.status,
    });
  }
  if (!response.ok || !result?.ok) {
    throw new TelegramApiError(result?.description || `Telegram returned HTTP ${response.status}`, {
      status: response.status,
      retryAfter: Number(result?.parameters?.retry_after) || null,
    });
  }
  return result.result;
}

