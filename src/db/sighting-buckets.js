import { getSupabase } from "./supabase.js";

export async function loadSightingBuckets(client = getSupabase()) {
  if (!client) return [];
  const { data, error } = await client.from("sighting_buckets")
    .select("id,primary_key,sighting_bucket_members(record_key)");
  // During rollout all records remain independent until the migration exists.
  if (error?.code === "PGRST205" || error?.code === "42P01") return [];
  if (error) throw error;
  return (data || []).map(row => ({ id: row.id, primaryKey: row.primary_key,
    memberKeys: row.sighting_bucket_members.map(member => member.record_key) }));
}

export async function saveSightingBucketPlan(groups, client = getSupabase()) {
  if (!client) throw new Error("Supabase is not configured");
  const { data, error } = await client.rpc("apply_sighting_bucket_plan", { p_groups: groups });
  if (error) throw error;
  return data;
}
