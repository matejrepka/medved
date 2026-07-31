import nodemailer from "nodemailer";

import { createEmailToken } from "./tokens.js";
import { buildConfirmationEmail, buildWarningEmail } from "./templates.js";
import {
  cancelEmailNotification,
  claimEmailNotifications,
  loadEmailDeliverySubscription,
  markEmailNotificationSent,
  rescheduleEmailNotification,
} from "../db/email-outbox.js";

export class EmailService {
  constructor({
    config,
    transport = null,
    claim = claimEmailNotifications,
    loadSubscription = loadEmailDeliverySubscription,
    markSent = markEmailNotificationSent,
    cancel = cancelEmailNotification,
    reschedule = rescheduleEmailNotification,
    logger = console,
  }) {
    this.config = config;
    this.transport = transport || (config.enabled ? nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.secure,
      requireTLS: config.requireTls,
      auth: { user: config.smtpUser, pass: config.smtpPass },
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    }) : null);
    this.claim = claim;
    this.loadSubscription = loadSubscription;
    this.markSent = markSent;
    this.cancel = cancel;
    this.reschedule = reschedule;
    this.logger = logger;
    this.inFlight = null;
    this.timer = null;
  }

  async sendConfirmation(subscription) {
    if (!this.config.enabled || !this.transport) throw new Error("Email delivery is not configured");
    const token = createEmailToken({
      subscription,
      purpose: "confirm",
      secret: this.config.tokenSecret,
      ttlSeconds: this.config.confirmationTtlSeconds,
    });
    const message = buildConfirmationEmail({ subscription, token, config: this.config });
    return this.#send(subscription.email, message);
  }

  async runAvailable(maxBatches = 3) {
    if (!this.config.enabled) return { processed: 0, sent: 0, disabled: true };
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
        const subscription = await this.loadSubscription(row.subscription_id);
        if (!subscription?.active || !subscription?.confirmed_at || !subscription.confirmation_nonce) {
          await this.cancel(row.id);
          continue;
        }
        const unsubscribeToken = createEmailToken({
          subscription,
          purpose: "unsubscribe",
          secret: this.config.tokenSecret,
        });
        const message = buildWarningEmail({ row, subscription, unsubscribeToken, config: this.config });
        const info = await this.#send(subscription.email, message, {
          "List-Unsubscribe": `<${message.unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          "Auto-Submitted": "auto-generated",
          Precedence: "bulk",
        });
        await this.markSent(row.id, info.messageId);
        sent += 1;
      } catch (error) {
        this.logger.error(`[email] notification ${row.id} failed: ${error.message}`);
        await this.reschedule(row, error);
      }
    }
    return { processed: rows.length, sent };
  }

  async #send(to, message, headers = undefined) {
    const info = await this.transport.sendMail({
      from: this.config.from,
      replyTo: this.config.replyTo || undefined,
      to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      messageId: message.messageId,
      headers,
    });
    if (Array.isArray(info.rejected) && info.rejected.length) {
      throw new Error(`SMTP rejected recipient: ${info.rejected.join(", ")}`);
    }
    return info;
  }

  start() {
    if (!this.config.enabled || this.timer) return;
    this.runAvailable().catch((error) => this.logger.error(`[email] outbox failed: ${error.message}`));
    this.timer = setInterval(() => {
      this.runAvailable().catch((error) => this.logger.error(`[email] outbox failed: ${error.message}`));
    }, this.config.pollIntervalMs);
    this.timer.unref?.();
  }

  kick() {
    if (!this.config.enabled) return;
    queueMicrotask(() => {
      this.runAvailable().catch((error) => this.logger.error(`[email] outbox failed: ${error.message}`));
    });
  }
}
