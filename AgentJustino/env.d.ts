/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OLLAMA_BASE_URL?: string;
  readonly VITE_OLLAMA_EMBED_MODEL?: string;
  readonly VITE_OLLAMA_CHAT_MODEL?: string;
  readonly VITE_OLLAMA_FALLBACK_MODELS?: string;
  readonly VITE_LLM_MAX_MODEL_CALLS?: string;
  readonly VITE_LLM_TIMEOUT_MS?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
