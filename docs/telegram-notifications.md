# Telegram notifications and mobile moderation

The integration sends one private Telegram card for each newly inserted event:

- a public bear report waiting for moderation;
- an imported news item waiting for moderation (an AI `warning` classification is
  shown on the same card and never creates a second notification);
- a warning newly inserted by one of the sightings scrapers, including all merged
  source identities;
- an admin-created `warning`, `news-warning`, or `tumedved` item.

Pending public reports and imported news have **Approve** and **Reject** buttons.
Reject requires a second confirmation. Each successful callback updates the existing
`bear_reports` or `news_logs` row and writes `content_moderation_audit` in the same
database transaction.

## Setup

1. Run `docs/migration-005-telegram-notifications.sql` in the Supabase SQL editor.
2. Open Telegram's verified `@BotFather`, use `/newbot`, and store the issued token
   directly in the deployment secret store. Do not paste it into source files, task
   messages, screenshots, or committed shell commands.
3. Open a direct conversation with the new bot and send `/start`. Before registering
   the webhook, call the Bot API `getUpdates` method from a secret-safe API client and
   read `message.chat.id` from that private message; `message.chat.type` must be
   `private`. Use this positive numeric ID as the destination/allowed chat ID.
4. Set the variables documented in `.env.example` in the deployment secret store:
   - `TELEGRAM_BOT_TOKEN` — bot token;
   - `TELEGRAM_CHAT_ID` — positive numeric ID of the private destination chat;
   - `TELEGRAM_ALLOWED_CHAT_IDS` — optional comma-separated additional private
     chat IDs allowed to press moderation buttons (the destination is always included);
   - `TELEGRAM_WEBHOOK_SECRET` — a random 16–256 character value using only
     letters, digits, `_`, and `-`;
   - `SITE_URL` — public HTTPS origin used for the admin link and webhook URL.
5. Deploy the application at the public HTTPS `SITE_URL`. The webhook endpoint must
   be internet-reachable with a valid TLS certificate; a localhost or plain HTTP URL
   cannot receive Telegram webhooks. On Vercel, redeploy after adding or changing the
   environment variables so the running function receives them.
6. Register `${SITE_URL}/api/telegram/webhook` with Telegram's `setWebhook` method,
   pass the same value as `secret_token`, and request `callback_query` updates. Keep
   both secrets in the deployment store, not in source control or shell history.

The bot token, destination chat, webhook secret, and `SITE_URL` must be valid before the worker or webhook
is enabled. Missing or invalid configuration leaves the feature inert. The webhook
checks Telegram's secret header with a timing-safe comparison, then accepts moderation
only from an explicitly allowed chat whose Telegram type is `private`.

## Delivery behavior

Database triggers insert the content row and its immutable notification snapshot in
the same transaction. `dedupe_key` prevents repeat cards. A worker claims rows with
`FOR UPDATE SKIP LOCKED`, sends through the native Telegram Bot API, and records the
message ID. Failures use exponential retry (or Telegram's `retry_after`) and become
`dead` after ten attempts. An abandoned `processing` claim is recoverable after five
minutes. The server checks the queue every 30 seconds and also wakes it immediately
after content refreshes or inserts. Cron refresh and insert requests also await a
bounded best-effort drain, so delivery does not depend on timers continuing after a
serverless response; the timer is only an optimization for persistent Node hosts.

The migration also widens the existing `scrape_runs.source` check to accept
`sightings`, matching the aggregate sightings store that already records refreshes.
