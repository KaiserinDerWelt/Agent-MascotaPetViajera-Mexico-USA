// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaError, ollamaChat, ollamaEmbed } from "./ollama.ts";
import { allowedModels, handleOllamaProxy } from "./ollamaProxy.ts";
import { classifyFailure, FAILURE_MESSAGES, getAnswerModels } from "./chat.ts";

type Call = { url: string; init?: RequestInit };

function fakeFetch(status: number, body: unknown, calls: Call[] = []) {
  return async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
}

const BASE = { baseUrl: "http://ollama.test" };

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

test("ollamaEmbed posts to /api/embed and returns the vectors", async () => {
  const calls: Call[] = [];
  const vectors = await ollamaEmbed("hola", { ...BASE, model: "all-minilm:22m", fetch: fakeFetch(200, { embeddings: [[0.1, 0.2]] }, calls) });
  assert.deepEqual(vectors, [[0.1, 0.2]]);
  assert.equal(calls[0].url, "http://ollama.test/api/embed");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { model: "all-minilm:22m", input: "hola" });
});

test("ollamaEmbed rejects a response without embeddings", async () => {
  await assert.rejects(ollamaEmbed("hola", { ...BASE, fetch: fakeFetch(200, { embeddings: [] }) }), (error: unknown) => {
    return error instanceof OllamaError && error.kind === "bad_response";
  });
});

test("ollamaChat sends stream:false, num_ctx and returns message.content", async () => {
  const calls: Call[] = [];
  const answer = await ollamaChat([{ role: "user", content: "hola" }], {
    ...BASE,
    model: "qwen2.5:7b",
    numCtx: 4096,
    fetch: fakeFetch(200, { message: { role: "assistant", content: "¡Guau!" }, done: true }, calls),
  });
  assert.equal(answer, "¡Guau!");
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(calls[0].url, "http://ollama.test/api/chat");
  assert.equal(body.stream, false);
  assert.equal(body.options.num_ctx, 4096);
  assert.equal(body.model, "qwen2.5:7b");
});

test("a missing model is reported as model_missing", async () => {
  const fetch = fakeFetch(404, { error: "model 'qwen2.5:7b' not found" });
  await assert.rejects(ollamaChat([], { ...BASE, model: "qwen2.5:7b", fetch }), (error: unknown) => {
    return error instanceof OllamaError && error.kind === "model_missing" && error.status === 404;
  });
});

test("a network failure is reported as unreachable", async () => {
  const fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(ollamaEmbed("hola", { ...BASE, fetch }), (error: unknown) => {
    return error instanceof OllamaError && error.kind === "unreachable";
  });
});

test("a proxy 502 (tunnel down) is reported as unreachable", async () => {
  await assert.rejects(ollamaEmbed("hola", { ...BASE, fetch: fakeFetch(502, "<html>Bad gateway</html>") }), (error: unknown) => {
    return error instanceof OllamaError && error.kind === "unreachable";
  });
});

test("a slow response is aborted and reported as timeout", async () => {
  const fetch = (_url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  await assert.rejects(ollamaChat([], { ...BASE, model: "m", timeoutMs: 20, fetch }), (error: unknown) => {
    return error instanceof OllamaError && error.kind === "timeout";
  });
});

test("Ollama Cloud calls send the Bearer key; local calls don't", async () => {
  const calls: Call[] = [];
  const fetch = fakeFetch(200, { message: { content: "ok" } }, calls);
  await ollamaChat([], { model: "glm-5.3-flash", baseUrl: "https://ollama.com", apiKey: "k-123", fetch });
  await ollamaChat([], { model: "gemma3:4b", baseUrl: "http://localhost:11434", apiKey: "k-123", fetch });
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer k-123");
  assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, undefined);
});

test("Ollama Cloud without a key fails fast as auth, without a request", async () => {
  const calls: Call[] = [];
  await assert.rejects(
    ollamaChat([], { model: "glm-5.3-flash", baseUrl: "https://ollama.com", apiKey: "", fetch: fakeFetch(200, {}, calls) }),
    (error: unknown) => error instanceof OllamaError && error.kind === "auth",
  );
  assert.equal(calls.length, 0);
});

test("401, 402 and 429 map to auth, credits and rate_limited", async () => {
  const cases: Array<[number, string]> = [[401, "auth"], [402, "credits"], [429, "rate_limited"]];
  for (const [status, kind] of cases) {
    await assert.rejects(
      ollamaChat([], { ...BASE, model: "m", fetch: fakeFetch(status, { error: "nope" }) }),
      (error: unknown) => error instanceof OllamaError && error.kind === kind && error.status === status,
    );
  }
});

// ---------------------------------------------------------------------------
// chat.ts: model selection and error mapping
// ---------------------------------------------------------------------------

test("answer models: primary, then fallbacks, capped and deduped", () => {
  const saved = { ...process.env };
  try {
    process.env.VITE_OLLAMA_CHAT_MODEL = "justino";
    process.env.VITE_OLLAMA_FALLBACK_MODELS = "qwen2.5:7b, justino, gemma3:4b";
    process.env.VITE_LLM_MAX_MODEL_CALLS = "2";
    assert.deepEqual(getAnswerModels(), ["justino", "qwen2.5:7b"]);

    delete process.env.VITE_OLLAMA_CHAT_MODEL;
    delete process.env.VITE_OLLAMA_FALLBACK_MODELS;
    delete process.env.VITE_LLM_MAX_MODEL_CALLS;
    assert.deepEqual(getAnswerModels(), ["glm-5.3-flash", "gpt-oss:20b"]);
  } finally {
    process.env = saved;
  }
});

test("failures map to user-facing messages without vendor names", () => {
  assert.equal(classifyFailure(new OllamaError("unreachable", "x")), "model_unreachable");
  assert.equal(classifyFailure(new OllamaError("timeout", "x")), "model_unreachable");
  assert.equal(classifyFailure(new OllamaError("model_missing", "x")), "model_missing");
  assert.equal(classifyFailure(new Error("Supabase error")), "database");
  for (const message of Object.values(FAILURE_MESSAGES)) {
    assert.doesNotMatch(message, /hugging|ollama/i);
  }
});

// ---------------------------------------------------------------------------
// Production proxy (security-relevant)
// ---------------------------------------------------------------------------

const ENV = { OLLAMA_UPSTREAM_URL: "http://upstream.test/", OLLAMA_UPSTREAM_TOKEN: "secret", OLLAMA_API_KEY: "cloud-key" };

function post(body: unknown, method = "POST") {
  return new Request("https://justino.test/api/ollama", {
    method,
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

test("proxy sends chat to Ollama Cloud with OLLAMA_API_KEY and clamps limits", async () => {
  const calls: Call[] = [];
  const response = await handleOllamaProxy(
    post({ model: "glm-5.3-flash", messages: [], stream: true, options: { num_predict: 99999, num_ctx: 100000 } }),
    "api/chat",
    ENV,
    fakeFetch(200, { message: { content: "ok" } }, calls),
  );
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, "https://ollama.com/api/chat");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer cloud-key");
  const forwarded = JSON.parse(String(calls[0].init?.body));
  assert.equal(forwarded.stream, false);
  assert.equal(forwarded.options.num_predict, 512);
  assert.equal(forwarded.options.num_ctx, 8192);
});

test("proxy sends embeddings to the self-hosted upstream with its own token", async () => {
  const calls: Call[] = [];
  await handleOllamaProxy(post({ model: "all-minilm:22m", input: "x" }), "api/embed", ENV, fakeFetch(200, {}, calls));
  assert.equal(calls[0].url, "http://upstream.test/api/embed");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer secret");
});

test("proxy refuses cloud chat when OLLAMA_API_KEY is missing on the server", async () => {
  const calls: Call[] = [];
  const env = { OLLAMA_UPSTREAM_URL: "http://upstream.test" };
  assert.equal((await handleOllamaProxy(post({ model: "glm-5.3-flash" }), "api/chat", env, fakeFetch(200, {}, calls))).status, 503);
  assert.equal(calls.length, 0);
});

test("proxy blocks admin endpoints, other models, GET and bad JSON", async () => {
  const calls: Call[] = [];
  const fetch = fakeFetch(200, {}, calls);
  for (const path of ["api/pull", "api/delete", "api/create", "api/tags", "../api/chat"]) {
    assert.equal((await handleOllamaProxy(post({ model: "glm-5.3-flash" }), path, ENV, fetch)).status, 404, path);
  }
  assert.equal((await handleOllamaProxy(post({ model: "llama3:70b" }), "api/chat", ENV, fetch)).status, 403);
  assert.equal((await handleOllamaProxy(post({}), "api/embed", ENV, fetch)).status, 403);
  assert.equal((await handleOllamaProxy(post(null, "GET"), "api/chat", ENV, fetch)).status, 405);
  assert.equal((await handleOllamaProxy(post("{nope"), "api/chat", ENV, fetch)).status, 400);
  assert.equal((await handleOllamaProxy(post("x".repeat(70000)), "api/chat", ENV, fetch)).status, 413);
  assert.equal(calls.length, 0);
});

test("proxy returns 503 without an upstream and 502 when it is down", async () => {
  assert.equal((await handleOllamaProxy(post({ model: "all-minilm:22m" }), "api/embed", {})).status, 503);
  const down = async () => {
    throw new TypeError("fetch failed");
  };
  assert.equal((await handleOllamaProxy(post({ model: "all-minilm:22m", input: "x" }), "api/embed", ENV, down)).status, 502);
});

test("proxy model allowlist: explicit list wins over app config", () => {
  assert.deepEqual([...allowedModels({ OLLAMA_ALLOWED_MODELS: "a, b" })], ["a", "b"]);
  assert.deepEqual([...allowedModels({ VITE_OLLAMA_CHAT_MODEL: "justino", VITE_OLLAMA_FALLBACK_MODELS: "qwen2.5:7b" })], [
    "all-minilm:22m",
    "justino",
    "qwen2.5:7b",
  ]);
});
