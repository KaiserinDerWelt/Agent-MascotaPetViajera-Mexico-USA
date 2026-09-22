
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HF_API_KEY: string;
  readonly SUPABASE_URL: string;
  readonly SUPABASE_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
