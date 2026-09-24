import { createClient } from "@supabase/supabase-js";

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL ?? "").trim();
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim();

export const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

export function ensureSupabaseConfigured() {
  if (!supabase) {
    throw new Error("Falta la configuración de Supabase. Revisa VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.");
  }

  return supabase;
}
