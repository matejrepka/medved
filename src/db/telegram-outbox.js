import { getSupabase } from "./supabase.js";

export async function claimTelegramNotifications(limit, reportsOnly = false) {
  const supabase = getSupabase();
  if (!supabase) return [];
  if (reportsOnly) {
    // Email-only deployments leave unrelated Telegram events untouched. Compare
    // attempts and status when claiming so concurrent workers cannot both win.
    const now = new Date().toISOString();
    const stale = new Date(Date.now() - 300_000).toISOString();
    const { data: candidates, error: queryError } = await supabase
      .from("telegram_notification_outbox").select("*")
      .eq("event_type", "pending_public_report")
      .or(`and(status.eq.pending,available_at.lte.${now}),and(status.eq.processing,locked_at.lt.${stale})`)
      .order("id").limit(Math.max(1, Math.min(50, limit || 10)));
    if (queryError) throw queryError;
    const claimed = [];
    for (const row of candidates || []) {
      const { data, error } = await supabase.from("telegram_notification_outbox")
        .update({ status: "processing", attempts: row.attempts + 1, locked_at: now, updated_at: now })
        .eq("id", row.id).eq("status", row.status).eq("attempts", row.attempts)
        .select("*");
      if (error) throw error;
      claimed.push(...(data || []));
    }
    return claimed;
  }
  const { data, error } = await supabase.rpc("claim_telegram_notification_outbox", {
    p_limit: limit,
  });
  if (error) throw error;
  return data || [];
}

export async function claimTelegramNotificationForAggregate(aggregateType, aggregateId) {
  const supabase = getSupabase();
  if (!supabase || !aggregateType || aggregateId == null) return [];
  const { data, error } = await supabase.rpc("claim_telegram_notification_for_aggregate", {
    p_aggregate_type: String(aggregateType),
    p_aggregate_id: String(aggregateId),
  });
  if (error) throw error;
  return data || [];
}

export async function markTelegramNotificationSent(id, messageId) {
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase
    .from("telegram_notification_outbox")
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      telegram_message_id: messageId,
      locked_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "processing");
  if (error) throw error;
}

export async function rescheduleTelegramNotification(row, error, retryAfter) {
  const supabase = getSupabase();
  if (!supabase) return;
  const exhausted = row.attempts >= 10;
  const seconds = retryAfter || Math.min(3600, 5 * (2 ** Math.max(0, row.attempts - 1)));
  const availableAt = new Date(Date.now() + seconds * 1000).toISOString();
  const { error: updateError } = await supabase
    .from("telegram_notification_outbox")
    .update({
      status: exhausted ? "dead" : "pending",
      available_at: availableAt,
      locked_at: null,
      last_error: String(error?.message || error || "Unknown Telegram error").slice(0, 2000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("status", "processing");
  if (updateError) throw updateError;
}

export async function moderateTelegramOutboxItem({ outboxId, action, chatId, actor, callbackId }) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase.rpc("telegram_moderate_outbox_item", {
    p_outbox_id: outboxId,
    p_action: action,
    p_chat_id: String(chatId),
    p_actor_user: actor || {},
    p_callback_query_id: callbackId,
  });
  if (error) throw error;
  return data;
}
