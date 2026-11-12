// Minimal Ollama client (native /api/embed and /api/chat), using fetch only.
// Works in the browser (calls the same-origin /ollama proxy) and in Node (scripts, tests).
//
// Chat runs on Ollama Cloud (https://ollama.com, needs OLLAMA_API_KEY).
// Embeddings run on a local/self-hosted Ollama: Ollama Cloud has no embedding models.
// The browser never sees OLLAMA_API_KEY: it calls /ollama/*, and the server-side proxy
// (lib/ollamaProxy.ts, used by Vite in dev and api/ollama.ts on Vercel) adds the key.
// See docs/ollama-migration-plan.md.

type EnvRecord = Record<string, string | undefined>;

export function readEnv(name: string): string {
  const viteEnv: EnvRecord = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};
  const nodeEnv: EnvRecord = typeof process !== "undefined" ? process.env ?? {} : {};
  return (viteEnv[name] ?? nodeEnv[name] ?? "").trim();
}

const isBrowser = typeof window !== "undefined" && typeof window.document !== "undefined";

export const OLLAMA_CLOUD_URL = "https://ollama.com";

function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Embeddings. Browser: same-origin "/ollama" proxy. Node: local/self-hosted Ollama. */
export function resolveOllamaBaseUrl(): string {
  if (isBrowser) return trimUrl(readEnv("VITE_OLLAMA_BASE_URL") || "/ollama");
  return trimUrl(readEnv("OLLAMA_BASE_URL") || readEnv("VITE_OLLAMA_BASE_URL") || "http://localhost:11434");
}

/** Chat. Browser: same-origin "/ollama" proxy. Node: Ollama Cloud unless OLLAMA_CHAT_BASE_URL says otherwise. */
export function resolveChatBaseUrl(): string {
  if (isBrowser) return trimUrl(readEnv("VITE_OLLAMA_BASE_URL") || "/ollama");
  return trimUrl(readEnv("OLLAMA_CHAT_BASE_URL") || OLLAMA_CLOUD_URL);
}

export function isOllamaCloud(url: string): boolean {
  try {
    return new URL(url).hostname === "ollama.com";
  } catch {
    return false;
  }
}

/** Bearer header for Ollama Cloud. Server-side only: never reads the key in the browser. */
function authHeaders(baseUrl: string, apiKey?: string): Record<string, string> {
  if (isBrowser || !isOllamaCloud(baseUrl)) return {};
  const key = apiKey ?? (typeof process !== "undefined" ? process.env?.OLLAMA_API_KEY ?? "" : "").trim();
  if (!key) {
    throw new OllamaError("auth", "Falta OLLAMA_API_KEY para llamar a Ollama Cloud.", 401);
  }
  return { Authorization: `Bearer ${key}` };
}

/** Pinned to the L6-v2 variant: 384 dims, same as the vectors stored in Supabase. */
export const DEFAULT_EMBED_MODEL = "all-minilm:22m";
export const EMBEDDING_DIMENSIONS = 384;

export function resolveEmbedModel(): string {
  return readEnv("VITE_OLLAMA_EMBED_MODEL") || DEFAULT_EMBED_MODEL;
}

export type OllamaErrorKind =
  | "unreachable"
  | "model_missing"
  | "timeout"
  | "bad_response"
  | "auth" // 401/403: OLLAMA_API_KEY missing or wrong
  | "credits" // 402: Ollama Cloud account needs usage credits
  | "rate_limited" // 429: usage limit reached
  | "http";

export class OllamaError extends Error {
  kind: OllamaErrorKind;
  status?: number;

  constructor(kind: OllamaErrorKind, message: string, status?: number) {
    super(message);
    this.name = "OllamaError";
    this.kind = kind;
    this.status = status;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type RequestOptions = {
  baseUrl?: string;
  /** Overrides process.env.OLLAMA_API_KEY (Node only). */
  apiKey?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
};

async function postJson(path: string, body: unknown, options: RequestOptions = {}): Promise<unknown> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? resolveOllamaBaseUrl();
  const url = `${baseUrl}${path}`;
  const headers = { "Content-Type": "application/json", ...authHeaders(baseUrl, options.apiKey) };
  const controller = new AbortController();
  const timer = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new OllamaError("timeout", `Ollama timeout after ${options.timeoutMs} ms (${path})`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new OllamaError("unreachable", `Ollama unreachable at ${url}: ${message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload: unknown = undefined;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    // Non-JSON body (e.g. an HTML error page from a proxy or tunnel).
  }

  if (!response.ok) {
    const detail = (payload as { error?: unknown } | undefined)?.error;
    const message = typeof detail === "string" ? detail : text.slice(0, 200) || response.statusText;
    if (response.status === 404 && /model .*not found|not found, try pulling/i.test(message)) {
      throw new OllamaError("model_missing", `Ollama model missing: ${message}`, 404);
    }
    if (response.status === 401 || response.status === 403) {
      throw new OllamaError("auth", `Ollama auth failed (${response.status}): ${message}`, response.status);
    }
    if (response.status === 402) {
      throw new OllamaError("credits", `Ollama Cloud needs usage credits: ${message}`, 402);
    }
    if (response.status === 429) {
      throw new OllamaError("rate_limited", `Ollama usage limit reached: ${message}`, 429);
    }
    // Proxy/tunnel answering without a live Ollama behind it.
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw new OllamaError("unreachable", `Ollama upstream unavailable (${response.status}): ${message}`, response.status);
    }
    throw new OllamaError("http", `Ollama HTTP ${response.status}: ${message}`, response.status);
  }

  return payload;
}

/** Returns one vector per input. */
export async function ollamaEmbed(
  input: string | string[],
  options: RequestOptions & { model?: string } = {},
): Promise<number[][]> {
  const model = options.model ?? resolveEmbedModel();
  const payload = await postJson("/api/embed", { model, input }, { timeoutMs: 30000, ...options });
  const embeddings = (payload as { embeddings?: unknown } | undefined)?.embeddings;

  const valid =
    Array.isArray(embeddings) &&
    embeddings.length > 0 &&
    embeddings.every((vector) => Array.isArray(vector) && vector.length > 0 && vector.every((x) => typeof x === "number"));

  if (!valid) {
    throw new OllamaError("bad_response", "Ollama /api/embed returned no embeddings");
  }

  return embeddings as number[][];
}

export type OllamaChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type OllamaChatOptions = RequestOptions & {
  model: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** Context window. Ollama's default is small and silently truncates the start of the prompt. */
  numCtx?: number;
  keepAlive?: string;
  /** Thinking for reasoning models. Omitted = model default. */
  think?: boolean | "low" | "medium" | "high";
};

export async function ollamaChat(messages: OllamaChatMessage[], options: OllamaChatOptions): Promise<string> {
  const payload = await postJson(
    "/api/chat",
    {
      model: options.model,
      messages,
      stream: false,
      ...(options.think !== undefined ? { think: options.think } : {}),
      keep_alive: options.keepAlive ?? "30m",
      options: {
        temperature: options.temperature ?? 0.3,
        top_p: options.topP ?? 0.9,
        num_predict: options.maxTokens ?? 320,
        num_ctx: options.numCtx ?? 4096,
      },
    },
    { baseUrl: resolveChatBaseUrl(), ...options },
  );

  const content = (payload as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (typeof content !== "string") {
    throw new OllamaError("bad_response", "Ollama /api/chat returned no message content");
  }

  return content;
}
