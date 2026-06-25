import "dotenv/config";
import { getSupabase } from "./src/db/supabase.js";

async function test() {
  const supabase = getSupabase();
  if (!supabase) {
    console.log("Supabase client is null. Check env vars.");
    return;
  }
  
  console.log("Supabase client initialized. Testing connection...");
  const { data, error } = await supabase.from("tumedved_logs").select("id").limit(1);
  
  if (error) {
    console.error("Error querying Supabase:", error);
  } else {
    console.log("Success! Connected to Supabase. Data:", data);
  }
}

test();
