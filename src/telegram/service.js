import crypto from "node:crypto";

import { callTelegramApi } from "./api.js";
import {
  buildTelegramCard,
  confirmationKeyboard,
  normalKeyboard,
} from "./cards.js";
import { isAllowedPrivateCallback } from "./config.js";
import {
  claimTelegramNotifications,
  markTelegramNotificationSent,
  moderateTelegramOutboxItem,
  rescheduleTelegramNotification,
} from "../db/telegram-outbox.js";

export function webhookSecretMatches(expected, received) {
  if (!expected || !received) return false;
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(received));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function parseModerationCallback(value) {
  const match = /^tm:([arcx]):([1-9]\d*)$/.exec(String(value || ""));
  return match ? { action: match[1], outboxId: Number(match[2]) } : null;
}

function actorFromCallback(query) {
  const from = query?.from || {};
  return {
    id: from.id,
    username: from.username,
    first_name: from.first_name,
    last_name: from.last_name,
  };
}

export class TelegramService {
  constructor({
    config,
    api = callTelegramApi,
    claim = claimTelegramNotifications,
    markSent = markTelegramNotificationSent,
    reschedule = rescheduleTelegramNotification,
    moderate = moderateTelegramOutboxItem,
    logger = console,
  }) {
    this.config = config;
    this.api = api;
    this.claim = claim;
    this.markSent = markSent;
    this.reschedule = reschedule;
    this.moderate = moderate;
    this.logger = logger;
    this.inFlight = null;
    this.timer = null;
  }

  async runOnce() {
    return this.runAvailable(1);
  }

  async runAvailable(maxBatches = 3) {
    if (!this.config.enabled) return { processed: 0, disabled: true };
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.#drainBatches(maxBatches);
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  async #drainBatches(maxBatches) {
    const boundedBatches = Math.max(1, Math.min(10, Number(maxBatches) || 1));
    const total = { processed: 0, sent: 0 };
    for (let batch = 0; batch < boundedBatches; batch += 1) {
      const result = await this.#drain();
      total.processed += result.processed;
      total.sent += result.sent;
      if (result.processed < this.config.batchSize) break;
    }
    return total;
  }

  async #drain() {
    const rows = await this.claim(this.config.batchSize);
    let sent = 0;
    for (const row of rows) {
      try {
        const card = buildTelegramCard(row, this.config);
        const message = await this.api(this.config, "sendMessage", {
          chat_id: this.config.chatId,
          ...card,
        });
        await this.markSent(row.id, message.message_id);
        sent += 1;
      } catch (error) {
        this.logger.error(`[telegram] notification ${row.id} failed: ${error.message}`);
        await this.reschedule(row, error, error.retryAfter);
      }
    }
    return { processed: rows.length, sent };
  }

  start() {
    if (!this.config.enabled || this.timer) return;
    this.runAvailable().catch((error) => this.logger.error(`[telegram] outbox failed: ${error.message}`));
    this.timer = setInterval(() => {
      this.runAvailable().catch((error) => this.logger.error(`[telegram] outbox failed: ${error.message}`));
    }, this.config.pollIntervalMs);
    this.timer.unref?.();
  }

  kick() {
    if (!this.config.enabled) return;
    queueMicrotask(() => {
      this.runAvailable().catch((error) => this.logger.error(`[telegram] outbox failed: ${error.message}`));
    });
  }

  async handleUpdate(update) {
    const query = update?.callback_query;
    const parsed = parseModerationCallback(query?.data);
    if (!query || !parsed) return { handled: false };

    if (!isAllowedPrivateCallback(this.config, query)) {
      await this.api(this.config, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Tento chat nemá povolenú moderáciu.",
        show_alert: true,
      }).catch(() => {});
      return { handled: true, authorized: false };
    }

    const message = query.message;
    const editMarkup = (replyMarkup) => this.api(this.config, "editMessageReplyMarkup", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      reply_markup: replyMarkup,
    });

    if (parsed.action === "r") {
      await editMarkup(confirmationKeyboard(parsed.outboxId));
      await this.api(this.config, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Zamietnutie treba potvrdiť.",
      });
      return { handled: true, confirmation: true };
    }

    if (parsed.action === "x") {
      await editMarkup(normalKeyboard(parsed.outboxId));
      await this.api(this.config, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Zamietnutie zrušené.",
      });
      return { handled: true, cancelled: true };
    }

    const action = parsed.action === "a" ? "approved" : "rejected";
    const result = await this.moderate({
      outboxId: parsed.outboxId,
      action,
      chatId: message.chat.id,
      actor: actorFromCallback(query),
      callbackId: query.id,
    });
    if (result?.outcome === "needs_admin_review") {
      await this.api(this.config, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "AI varovanie nemá overenú lokalitu. Dokončite ho v administrácii.",
        show_alert: true,
      });
      return { handled: true, authorized: true, needsAdminReview: true, status: "pending" };
    }
    if (!result || !["approved", "rejected"].includes(result.status)) {
      throw new Error("Moderation returned an unsupported outcome");
    }

    const statusLabel = result.status === "approved" ? "Schválené" : "Zamietnuté";
    const marker = result.status === "approved" ? "✅" : "❌";
    await this.api(this.config, "editMessageText", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: `${message.text || "Moderovaná položka"}\n\n${marker} ${statusLabel} cez Telegram.`,
      disable_web_page_preview: true,
    });
    await this.api(this.config, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: result?.changed === false ? `Položka už má stav: ${statusLabel}.` : statusLabel,
    });
    return { handled: true, authorized: true, status: result.status };
  }
}
