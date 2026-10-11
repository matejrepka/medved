import { createClient } from "@supabase/supabase-js";
import { getEnvironment } from "#platform";

let client = null;
let clientUrl = null;
let clientKey = null;

export function isSupabaseConfigured() {
  const env = getEnvironment();
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getSupabase() {
  const { SUPABASE_URL: supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: supabaseServiceKey } = getEnvironment();
  if (!supabaseUrl || !supabaseServiceKey) return null;
  if (!client || clientUrl !== supabaseUrl || clientKey !== supabaseServiceKey) {
    client = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
    clientUrl = supabaseUrl;
    clientKey = supabaseServiceKey;
  }
  return client;
}
