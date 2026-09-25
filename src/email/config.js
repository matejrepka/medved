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

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).trim().toLowerCase() === "true";
}

function digestHours(value) {
  const parsed = String(value || "6,12,18")
    .split(",")
    .map((hour) => Number.parseInt(hour.trim(), 10))
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);
  return [...new Set(parsed)].sort((a, b) => a - b);
}

export function readEmailConfig(env = process.env) {
  const smtpHost = String(env.SMTP_HOST || "").trim();
  const smtpPort = positiveInteger(env.SMTP_PORT, 587);
  const smtpUser = String(env.SMTP_USER || "").trim();
  const smtpPass = String(env.SMTP_PASS || "");
  const from = String(env.EMAIL_FROM || "").trim();
  const replyTo = String(env.EMAIL_REPLY_TO || "kontakt@kdejemedved.sk").trim();
  const feedbackTo = String(env.FEEDBACK_TO || replyTo).trim();
  const tokenSecret = String(env.NEWSLETTER_TOKEN_SECRET || "").trim();
  const siteOrigin = normalizeOrigin(env.SITE_URL);
  const secure = booleanValue(env.SMTP_SECURE, smtpPort === 465);

  const missing = [];
  if (!smtpHost) missing.push("SMTP_HOST");
  if (!smtpUser) missing.push("SMTP_USER");
  if (!smtpPass) missing.push("SMTP_PASS");
  if (!from) missing.push("EMAIL_FROM");
  if (!siteOrigin) missing.push("SITE_URL (https)");
  const moderationEnabled = missing.length === 0;
  if (tokenSecret.length < 32) missing.push("NEWSLETTER_TOKEN_SECRET (min. 32 znakov)");

  return {
    enabled: missing.length === 0,
    moderationEnabled,
    missing,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass,
    secure,
    requireTls: booleanValue(env.SMTP_REQUIRE_TLS, !secure),
    from,
    replyTo,
    feedbackTo,
    moderationTo: String(env.MODERATION_EMAIL_TO || "kdejemedved@gmail.com").trim(),
    tokenSecret,
    siteOrigin,
    batchSize: Math.min(50, positiveInteger(env.EMAIL_OUTBOX_BATCH_SIZE, 10)),
    pollIntervalMs: positiveInteger(env.EMAIL_POLL_INTERVAL_MS, 30_000),
    confirmationTtlSeconds: positiveInteger(env.EMAIL_CONFIRMATION_TTL_SECONDS, 86_400),
    digestHours: digestHours(env.EMAIL_DIGEST_HOURS),
    digestTimeZone: String(env.EMAIL_DIGEST_TIME_ZONE || "Europe/Bratislava").trim(),
    digestWindowMinutes: Math.min(60, positiveInteger(env.EMAIL_DIGEST_WINDOW_MINUTES, 60)),
  };
}
