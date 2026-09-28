import { createClient } from "@supabase/supabase-js";

const nodeEnv = typeof process !== "undefined" ? process.env ?? {} : {};
const viteEnv = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};
const supabaseUrl = (viteEnv.VITE_SUPABASE_URL ?? nodeEnv.VITE_SUPABASE_URL ?? "").trim();
const supabaseAnonKey = (viteEnv.VITE_SUPABASE_ANON_KEY ?? nodeEnv.VITE_SUPABASE_ANON_KEY ?? "").trim();

export const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

export function ensureSupabaseConfigured() {
  if (!supabase) {
    throw new Error("Falta la configuración de Supabase. Revisa VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.");
  }

  return supabase;
}
