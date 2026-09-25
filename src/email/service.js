import nodemailer from "nodemailer";

import { createEmailToken } from "./tokens.js";
import { buildConfirmationEmail, buildDigestEmail, buildFeedbackEmail, buildReportModerationEmail } from "./templates.js";
import {
  cancelEmailNotifications,
  claimEmailNotifications,
  loadEmailDeliverySubscription,
  markEmailNotificationsSent,
  rescheduleEmailNotifications,
} from "../db/email-outbox.js";

function digestSlot(date, config) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: config.digestTimeZone || "Europe/Bratislava",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const hours = config.digestHours || [6, 12, 18];
  const windowMinutes = config.digestWindowMinutes || 60;
  if (!hours.includes(hour) || minute >= windowMinutes) return null;
  return `${parts.year}-${parts.month}-${parts.day}-${parts.hour}`;
}

function groupBySubscription(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(row.subscription_id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()];
}

export class EmailService {
  constructor({
    config,
    transport = null,
    claim = claimEmailNotifications,
    loadSubscription = loadEmailDeliverySubscription,
    markSent = markEmailNotificationsSent,
    cancel = cancelEmailNotifications,
    reschedule = rescheduleEmailNotifications,
    logger = console,
  }) {
    this.config = config;
    this.transport = transport || (config.enabled || config.moderationEnabled ? nodemailer.createTransport({
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
    this.lastDigestSlot = null;
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

  async sendFeedback(feedback) {
    if (!this.config.enabled || !this.transport) throw new Error("Email delivery is not configured");
    const message = buildFeedbackEmail(feedback);
    return this.#send(
      this.config.feedbackTo || this.config.replyTo,
      message,
      undefined,
      feedback.email || this.config.replyTo
    );
  }

  async sendReportModeration(row) {
    if (!(this.config.moderationEnabled ?? this.config.enabled) || !this.transport) throw new Error("Email delivery is not configured");
    return this.#send(this.config.moderationTo, buildReportModerationEmail(row, this.config));
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

  async runScheduled(now = new Date(), maxBatches = 3) {
    if (!this.config.enabled) return { processed: 0, sent: 0, disabled: true };
    const slot = digestSlot(now, this.config);
    if (!slot || slot === this.lastDigestSlot) {
      return { processed: 0, sent: 0, scheduled: false };
    }
    this.lastDigestSlot = slot;
    return this.runAvailable(maxBatches);
  }

  async #drainBatches(maxBatches) {
    const boundedBatches = Math.max(1, Math.min(10, Number(maxBatches) || 1));
    const total = { processed: 0, sent: 0 };
    for (let batch = 0; batch < boundedBatches; batch += 1) {
      const result = await this.#drain();
      total.processed += result.processed;
      total.sent += result.sent;
      if (result.subscriptions < this.config.batchSize) break;
    }
    return total;
  }

  async #drain() {
    const rows = await this.claim(this.config.batchSize);
    let sent = 0;
    const groups = groupBySubscription(rows);
    for (const group of groups) {
      const firstRow = group[0];
      try {
        const subscription = await this.loadSubscription(firstRow.subscription_id);
        if (!subscription?.active || !subscription?.confirmed_at || !subscription.confirmation_nonce) {
          await this.cancel(group);
          continue;
        }
        const unsubscribeToken = createEmailToken({
          subscription,
          purpose: "unsubscribe",
          secret: this.config.tokenSecret,
        });
        const message = buildDigestEmail({ rows: group, subscription, unsubscribeToken, config: this.config });
        const info = await this.#send(subscription.email, message, {
          "List-Unsubscribe": `<${message.unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          "Auto-Submitted": "auto-generated",
          Precedence: "bulk",
        });
        await this.markSent(group, info.messageId);
        sent += 1;
      } catch (error) {
        this.logger.error(`[email] digest for subscription ${firstRow.subscription_id} failed: ${error.message}`);
        await this.reschedule(group, error);
      }
    }
    return { processed: rows.length, sent, subscriptions: groups.length };
  }

  async #send(to, message, headers = undefined, replyTo = this.config.replyTo) {
    const info = await this.transport.sendMail({
      from: this.config.from,
      replyTo: replyTo || undefined,
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
    this.runScheduled().catch((error) => this.logger.error(`[email] outbox failed: ${error.message}`));
    this.timer = setInterval(() => {
      this.runScheduled().catch((error) => this.logger.error(`[email] outbox failed: ${error.message}`));
    }, this.config.pollIntervalMs);
    this.timer.unref?.();
  }

  kick() {
    if (!this.config.enabled) return;
    queueMicrotask(() => {
      this.runScheduled().catch((error) => this.logger.error(`[email] outbox failed: ${error.message}`));
    });
  }
}
