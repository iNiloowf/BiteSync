import { createClient } from "@supabase/supabase-js";

const rawSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const rawSupabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
let browserClient: ReturnType<typeof createClient> | null = null;

function sanitizeValue(value?: string) {
  return value?.trim().replace(/^["']|["']$/g, "") ?? "";
}

function normalizeSupabaseUrl(value?: string) {
  const cleaned = sanitizeValue(value);
  if (!cleaned) {
    return "";
  }

  try {
    const parsed = new URL(cleaned);
    return parsed.origin;
  } catch {
    return cleaned;
  }
}

const supabaseUrl = normalizeSupabaseUrl(rawSupabaseUrl);
const supabaseAnonKey = sanitizeValue(rawSupabaseAnonKey);

export const hasSupabaseEnv = Boolean(supabaseUrl && supabaseAnonKey);
export const supabaseConfigError =
  hasSupabaseEnv && !/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl)
    ? "Supabase URL must look like https://YOUR_PROJECT.supabase.co"
    : "";

export function getSupabaseBrowserClient() {
  if (!supabaseUrl || !supabaseAnonKey || supabaseConfigError) {
    return null;
  }

  if (browserClient) {
    return browserClient;
  }

  browserClient = createClient(supabaseUrl, supabaseAnonKey);
  return browserClient;
}
