import { getSupabase } from "./supabase.js";

export async function claimEmailNotifications(limit) {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("claim_email_notification_outbox", {
    p_limit: limit,
  });
  if (error) throw error;
  return data || [];
}

export async function loadEmailDeliverySubscription(id) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("email_subscriptions")
    .select("id,email,notify_type,area_name,active,confirmed_at,confirmation_nonce")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function rowIds(rowsOrIds) {
  const values = Array.isArray(rowsOrIds) ? rowsOrIds : [rowsOrIds];
  return values
    .map((value) => (value && typeof value === "object" ? value.id : value))
    .filter((value) => value !== null && value !== undefined);
}

export async function markEmailNotificationsSent(rowsOrIds, messageId) {
  const supabase = getSupabase();
  if (!supabase) return;
  const ids = rowIds(rowsOrIds);
  if (!ids.length) return;
  const { error } = await supabase
    .from("email_notification_outbox")
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      smtp_message_id: messageId || null,
      locked_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .in("id", ids)
    .eq("status", "processing");
  if (error) throw error;
}

export async function cancelEmailNotifications(rowsOrIds, reason = "Subscription is inactive") {
  const supabase = getSupabase();
  if (!supabase) return;
  const ids = rowIds(rowsOrIds);
  if (!ids.length) return;
  const { error } = await supabase
    .from("email_notification_outbox")
    .update({
      status: "cancelled",
      locked_at: null,
      last_error: reason.slice(0, 2000),
      updated_at: new Date().toISOString(),
    })
    .in("id", ids)
    .eq("status", "processing");
  if (error) throw error;
}

export async function rescheduleEmailNotifications(rowsOrRow, error) {
  const supabase = getSupabase();
  if (!supabase) return;
  const rows = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];
  const ids = rowIds(rows);
  if (!ids.length) return;
  const attempts = Math.max(...rows.map((row) => Number(row?.attempts) || 0));
  const exhausted = attempts >= 8;
  const seconds = Math.min(6 * 3600, 30 * (2 ** Math.max(0, attempts - 1)));
  const availableAt = new Date(Date.now() + seconds * 1000).toISOString();
  const { error: updateError } = await supabase
    .from("email_notification_outbox")
    .update({
      status: exhausted ? "dead" : "pending",
      available_at: availableAt,
      locked_at: null,
      last_error: String(error?.message || error || "Unknown email error").slice(0, 2000),
      updated_at: new Date().toISOString(),
    })
    .in("id", ids)
    .eq("status", "processing");
  if (updateError) throw updateError;
}
