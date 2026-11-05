// Server-side proxy logic for /ollama/* (wrapped by api/ollama.ts on Vercel and by the Vite
// dev server in vite.config.ts). The browser never sees any key.
//
// - /api/chat  → Ollama Cloud (https://ollama.com), with Authorization: Bearer OLLAMA_API_KEY.
// - /api/embed → local/self-hosted Ollama (OLLAMA_EMBED_UPSTREAM_URL), because Ollama Cloud
//                has no embedding models. Self-hosted Ollama has no authentication, so this
//                proxy only forwards these two endpoints, for allowlisted models, with limits.

export type ProxyEnv = {
  OLLAMA_API_KEY?: string;
  /** Chat upstream. Default https://ollama.com. */
  OLLAMA_CHAT_UPSTREAM_URL?: string;
  /** Embedding upstream (tunnel/VPS running Ollama). Falls back to OLLAMA_UPSTREAM_URL. */
  OLLAMA_EMBED_UPSTREAM_URL?: string;
  OLLAMA_UPSTREAM_URL?: string;
  /** Bearer token for a self-hosted upstream's reverse proxy. */
  OLLAMA_UPSTREAM_TOKEN?: string;
  OLLAMA_ALLOWED_MODELS?: string;
  VITE_OLLAMA_EMBED_MODEL?: string;
  VITE_OLLAMA_CHAT_MODEL?: string;
  VITE_OLLAMA_FALLBACK_MODELS?: string;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const ALLOWED_PATHS = new Set(["api/embed", "api/chat"]);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PREDICT = 512;
const MAX_CTX = 8192;
export const UPSTREAM_TIMEOUT_MS = 85000;

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

/** Explicit OLLAMA_ALLOWED_MODELS wins; otherwise the models the app is configured to use. */
export function allowedModels(env: ProxyEnv): Set<string> {
  const explicit = list(env.OLLAMA_ALLOWED_MODELS);
  if (explicit.length) return new Set(explicit);

  return new Set([
    env.VITE_OLLAMA_EMBED_MODEL?.trim() || "all-minilm:22m",
    env.VITE_OLLAMA_CHAT_MODEL?.trim() || "glm-5.3-flash",
    ...(list(env.VITE_OLLAMA_FALLBACK_MODELS).length ? list(env.VITE_OLLAMA_FALLBACK_MODELS) : ["gpt-oss:20b"]),
  ]);
}

function isOllamaCloud(url: string): boolean {
  try {
    return new URL(url).hostname === "ollama.com";
  } catch {
    return false;
  }
}

/** Where a path goes and which Bearer token (if any) to send. */
export function resolveUpstream(path: string, env: ProxyEnv): { url: string; token?: string } | null {
  const url = (
    path === "api/chat"
      ? env.OLLAMA_CHAT_UPSTREAM_URL?.trim() || "https://ollama.com"
      : env.OLLAMA_EMBED_UPSTREAM_URL?.trim() || env.OLLAMA_UPSTREAM_URL?.trim() || ""
  ).replace(/\/+$/, "");
  if (!url) return null;

  const token = (isOllamaCloud(url) ? env.OLLAMA_API_KEY : env.OLLAMA_UPSTREAM_TOKEN)?.trim();
  return { url, token: token || undefined };
}

/** `path` is the part after /ollama/, e.g. "api/chat". */
export async function handleOllamaProxy(
  request: Request,
  path: string,
  env: ProxyEnv,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });

  const normalizedPath = path.replace(/^\/+|\/+$/g, "");
  if (!ALLOWED_PATHS.has(normalizedPath)) return json(404, { error: "Not found" });

  const upstream = resolveUpstream(normalizedPath, env);
  if (!upstream) return json(503, { error: "Ollama upstream is not configured" });
  if (isOllamaCloud(upstream.url) && !upstream.token) {
    return json(503, { error: "OLLAMA_API_KEY is not configured on the server" });
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json(413, { error: "Request too large" });

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  if (typeof body.model !== "string" || !allowedModels(env).has(body.model)) {
    return json(403, { error: "Model not allowed" });
  }

  if (normalizedPath === "api/chat") {
    const options = (body.options && typeof body.options === "object" ? body.options : {}) as Record<string, unknown>;
    const numPredict = Number(options.num_predict);
    const numCtx = Number(options.num_ctx);
    body = {
      ...body,
      stream: false,
      options: {
        ...options,
        num_predict: Number.isFinite(numPredict) && numPredict > 0 ? Math.min(numPredict, MAX_PREDICT) : MAX_PREDICT,
        ...(Number.isFinite(numCtx) && numCtx > 0 ? { num_ctx: Math.min(numCtx, MAX_CTX) } : {}),
      },
    };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (upstream.token) headers.Authorization = `Bearer ${upstream.token}`;

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetchImpl(`${upstream.url}/${normalizedPath}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json(502, { error: `Ollama upstream unreachable: ${message}` });
  }

  return new Response(await upstreamResponse.text(), {
    status: upstreamResponse.status,
    headers: { "Content-Type": upstreamResponse.headers.get("Content-Type") ?? "application/json" },
  });
}
