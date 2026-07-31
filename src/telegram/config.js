function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeOrigin(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function readTelegramConfig(env = process.env) {
  const botToken = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(env.TELEGRAM_CHAT_ID || "").trim();
  const webhookSecret = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  const siteOrigin = normalizeOrigin(env.SITE_URL);
  const validPrivateChatId = /^[1-9]\d*$/.test(chatId);
  const validWebhookSecret = /^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret);
  const allowedChatIds = new Set(
    String(env.TELEGRAM_ALLOWED_CHAT_IDS || chatId)
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^[1-9]\d*$/.test(id))
  );
  if (validPrivateChatId) allowedChatIds.add(chatId);

  return {
    enabled: Boolean(botToken && validPrivateChatId && validWebhookSecret && siteOrigin),
    botToken,
    chatId,
    webhookSecret,
    siteOrigin,
    allowedChatIds,
    pollIntervalMs: positiveInteger(env.TELEGRAM_POLL_INTERVAL_MS, 30_000),
    batchSize: Math.min(50, positiveInteger(env.TELEGRAM_OUTBOX_BATCH_SIZE, 10)),
  };
}

export function isAllowedPrivateCallback(config, callbackQuery) {
  const chat = callbackQuery?.message?.chat;
  return Boolean(
    config?.enabled &&
    chat?.type === "private" &&
    config.allowedChatIds.has(String(chat.id))
  );
}
