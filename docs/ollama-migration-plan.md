# Plan: replace Hugging Face with Ollama

**Status:** implemented (Phases 0–8) · **Branch:** `feature-OLLAMA-Instead-Hugging-Face` · **Written:** 2026-11-05

## Implementation results (2026-11-05)

- **Embeddings:** `all-minilm:22m` matches the stored vectors exactly. `npm run check-embeddings` gave cosine similarity 1.0000 on 20 of 20 rows. No re-embed and no schema change were needed.
- **Answer models:** default `qwen2.5:7b`, with fallback `gemma3:4b`. Verified end to end with `gemma3:4b` on an Apple Silicon laptop: about 21 seconds per answer once loaded, and about 83 seconds for the first call while the model loads. The fallback was verified with `qwen2.5:7b` not pulled.
- **Failure path verified:** with Ollama unreachable, greetings and out-of-scope replies still work, and in-scope questions get the `model_unreachable` message.
- **Proxy:** `api/ollama.ts` plus `vercel.json`, with its logic in `lib/ollamaProxy.ts`. The path and model allowlists are unit-tested. **Not yet deployed:** `OLLAMA_UPSTREAM_URL` and the tunnel still have to be set up.
- **Differences from the plan:**
  - `src/global.d.ts` was deleted, because it only held the HF declarations.
  - `reembed.ts` requires `SUPABASE_SERVICE_ROLE_KEY`, because the schema has no UPDATE policy for anon.
  - `scripts/uploadDocs.ts` now re-exports `lib/uploadDocs.ts`.
- **Update (same day): answers moved to Ollama Cloud.**
  - `api/chat` now goes to `https://ollama.com` with `Authorization: Bearer $OLLAMA_API_KEY`, using `glm-5.3-flash` with fallback `gpt-oss:20b`.
  - Ollama Cloud lists no embedding models, so `api/embed` stays on a self-hosted Ollama (`OLLAMA_EMBED_UPSTREAM_URL`).
  - The key is only read server-side: the Vite dev proxy, `api/ollama.ts` and scripts.
- **Still open:**
  - [ ] Deploy (Option A: tunnel, then set Vercel env vars)
  - [ ] Revoke the HF token and remove `VITE_HF_*` from `.env` and Vercel
  - [ ] Run the model evaluation in §6 with Ollama Cloud models
  - [ ] Phase 9 (optional)
  - [ ] LoRA (§7)

## Why

Hugging Face Inference Providers no longer include free monthly credits. The account has $0, so every in-scope question fails at the embedding step with HTTP 402. Ollama runs open models on hardware we control, with no per-call cost, and it serves both things Justino needs: **embeddings** and **chat completion**.

## Goals and non-goals

**Goals**

- Remove `@huggingface/inference` and every `VITE_HF_*` variable.
- Keep the RAG pipeline, scope guard, prompt, and evidence fallback exactly as they are. Only the model calls change.
- Keep the Supabase schema (`vector(384)`) if the embedding check in Phase 2 passes.
- Keep a clear path for the LoRA fine-tuned Justino model.
- The deployed Vercel app keeps working, not only `npm run dev`.

**Non-goals**

- Changing the embedding model to a multilingual one. That's an optional later step (see [Phase 9](#phase-9-optional-better-spanish-retrieval)).
- Streaming responses. Nice to have, but not needed for the swap.

---

## 1. Where Hugging Face is used today

| File | Uses | What changes |
|---|---|---|
| `AgentJustino/lib/huggingface.ts` | `HfInference` client, `ensureHfConfigured()` | **Delete.** Replaced by `lib/ollama.ts`. |
| `AgentJustino/lib/embeddings.ts` | `featureExtraction` with `all-MiniLM-L6-v2` | Call `ollamaEmbed()` |
| `AgentJustino/lib/uploadDocs.ts` | `featureExtraction` per chunk, duplicate `normalizeEmbedding` | Use `generateEmbedding()` from `embeddings.ts` (removes the duplication) |
| `AgentJustino/lib/chat.ts` | `chatCompletion`, model targets, HF error classes and messages | New targets, new error classes, call `ollamaChat()` |
| `AgentJustino/api/chat.ts` | Legacy handler using `featureExtraction` and `textGeneration` (Phi-3.5). Not used by the frontend. | **Replace** with the Ollama proxy function (Phase 6) |
| `AgentJustino/scripts/seedDocs.ts`, `scripts/uploadDocs.ts` | `hf.featureExtraction` | Use `generateEmbedding()` |
| `AgentJustino/scripts/repairChunks.ts` | Its own `HfInference` | Use `generateEmbedding()` |
| `AgentJustino/env.d.ts` | `VITE_HF_*` types | New `VITE_OLLAMA_*` types |
| `AgentJustino/src/global.d.ts` | `declare module "@huggingface/*"` | Remove both lines |
| `AgentJustino/package.json` | `@huggingface/inference` | Remove. No new dependency: Ollama is called with `fetch`. |
| `AgentJustino/lib/scope.ts` | Comment only ("before any Hugging Face call") | Reword |
| `README.md`, `CURRENT.md` | Architecture, stack, env vars, "HF is mandatory", troubleshooting | Update (Phase 8) |

`@huggingface/jinja` is declared in `global.d.ts` but isn't imported anywhere. Remove the declaration.

---

## 2. Target architecture

```
Browser (React + MUI)
  │
  ├─ 1. Question ──► /ollama/api/embed   model: all-minilm  → 384-dim vector
  │
  ├─ 2. Vector ────► Supabase rpc("match_documents")          (unchanged)
  │
  ├─ 3. Local post-processing                                 (unchanged)
  │
  └─ 4. Prompt ────► /ollama/api/chat    model: qwen2.5:7b (or the LoRA "justino")
                     └─ on failure: answer built from the retrieved text (unchanged)

/ollama/* is a same-origin path:
  - dev:  Vite proxy        → http://localhost:11434
  - prod: Vercel function   → OLLAMA_UPSTREAM_URL (+ secret header), only /api/embed and /api/chat
```

The browser always calls the same relative path, `/ollama`. That means:

- No CORS setup and no mixed-content problems (HTTPS page calling an HTTP Ollama).
- The upstream address and any secret stay on the server, unlike today's `VITE_HF_API_KEY`, which ships in the JavaScript bundle.
- Moving from a laptop to a VPS or a GPU box is an env change, not a code change.

### Ollama API calls used

```http
POST /api/embed
{ "model": "all-minilm", "input": "texto" }
→ { "embeddings": [[0.01, ...]] }

POST /api/chat
{ "model": "qwen2.5:7b", "messages": [...], "stream": false,
  "keep_alive": "30m",
  "options": { "temperature": 0.3, "top_p": 0.9, "num_predict": 320, "num_ctx": 4096 } }
→ { "message": { "role": "assistant", "content": "..." }, "done": true }
```

Use the native `/api/*` endpoints rather than the OpenAI-compatible `/v1/*` ones. `options.num_ctx` and `keep_alive` are only reliably available on the native endpoints.

- **Set `num_ctx` explicitly.** Ollama's default context window is small (2048 tokens on many versions). The system prompt, 4 chunks of about 600 characters and 6 history turns can exceed it. If they do, Ollama silently truncates the start of the prompt, which removes the system prompt and the scope rules.
- **Set `keep_alive`.** The first request after a model is unloaded can take 10 to 30 seconds while the model loads.

---

## 3. Phases

Each phase leaves the app building and `npm test` passing.

### Phase 0: Local setup and decisions (½ day)

1. Start Ollama (`ollama serve`, or the menu-bar app) and pull the models:
   ```bash
   ollama pull all-minilm      # embeddings, ~46 MB
   ollama pull qwen2.5:7b      # answer model, ~4.7 GB (same family as today's default)
   # already installed: gemma3:4b (lighter candidate)
   ```
2. Confirm that the `all-minilm` tag is the **L6-v2** variant (`all-minilm:22m`), not L12 (`:33m`). Both are 384-dim, but only L6 matches the stored vectors. Pin the tag you verify, for example `all-minilm:22m`, in config.
3. Decide on production hosting ([§4](#4-production-hosting-options)). This is the main open decision.

### Phase 1: Ollama client (`lib/ollama.ts`)

Create one small module with no dependencies that works in both the browser and Node (scripts, tests):

```ts
// lib/ollama.ts (sketch)
export function resolveOllamaBaseUrl(): string
//   browser: VITE_OLLAMA_BASE_URL ?? "/ollama"
//   node:    OLLAMA_BASE_URL ?? VITE_OLLAMA_BASE_URL ?? "http://localhost:11434"

export async function ollamaEmbed(input: string | string[], opts?): Promise<number[][]>
export async function ollamaChat(messages: ChatMessage[], opts: { model; temperature; topP; maxTokens; numCtx; timeoutMs }): Promise<string>

export class OllamaError extends Error { status?: number; kind: "unreachable" | "model_missing" | "timeout" | "bad_response" }
```

- Use `AbortController` for timeouts. The current `withTimeout` race leaves the request running in the background.
- Map errors to a `kind`:
  - network failure or `ECONNREFUSED` → `unreachable`
  - HTTP 404 with `model "…" not found` → `model_missing`
  - abort → `timeout`
  - missing `message.content` or `embeddings` → `bad_response`
- Accept an optional `fetch` argument so tests can pass a fake.
- Add `lib/ollama.test.ts` (with `node --test`, like `scope.test.ts`) covering response parsing and each error kind, using a fake `fetch`.

### Phase 2: Embeddings and vector compatibility check

1. Rewrite `generateEmbedding(text)` in `lib/embeddings.ts` to call `ollamaEmbed` and return `embeddings[0]`. Assert `length === 384`.
2. Make `lib/uploadDocs.ts` call `generateEmbedding()` and delete its copy of `normalizeEmbedding`.
3. **Compatibility check** (new script `scripts/checkEmbeddings.ts`, read-only):
   - Read about 20 rows (`id, content, embedding`) from `documents`.
   - Re-embed each `content` with Ollama.
   - Print the cosine similarity between the stored vector and the new one.
4. Decide based on the result:
   - **Every row ≥ 0.99:** the vectors are compatible. Keep the existing data. No schema change and no re-ingest.
   - **Lower:** pooling or normalization differs. Re-embed every row with Ollama **in place**, using a new `scripts/reembed.ts` that runs `update documents set embedding = … where id = …`.

   > Don't use `repairChunks.ts` for this. It **deletes every row** before re-inserting. If embedding fails halfway (for example, Ollama stops), the knowledge base is lost, and the source PDFs aren't in the repo. Updating in place is safe to re-run.

### Phase 3: Answer model in `lib/chat.ts`

1. Replace `DEFAULT_ANSWER_MODELS` and `getAnswerTargets()`:
   - Primary: `VITE_OLLAMA_CHAT_MODEL` (default `qwen2.5:7b`).
   - Fallbacks: `VITE_OLLAMA_FALLBACK_MODELS` (comma-separated, for example `gemma3:4b`).
   - Cap: `VITE_LLM_MAX_MODEL_CALLS` (default 2).
   - Remove `endpointUrl` and `provider`. They have no Ollama equivalent.
2. Replace `generateModelAnswer(hf, messages)` with a loop over targets that calls `ollamaChat`. Keep the `cleanModelAnswer` and `normalizeGeneratedText` behavior, simplified to `message.content`.
3. Timeout: `VITE_LLM_TIMEOUT_MS`, default **60000**. A 7B model on CPU, or on a cold load, is much slower than an HF provider. 20 seconds would fall back to evidence answers too often.
4. Short-circuit rules (replacing the 402/401 rule):
   - `unreachable`: stop. Every model is on the same server.
   - `model_missing` or `timeout`: try the next target.
5. Keep `buildChatMessages()` from `lib/prompt.ts` unchanged. It's the contract with the LoRA dataset.

### Phase 4: Errors and user-facing messages

Replace `FailureKind` `"hf_credits" | "hf_auth"` with `"model_unreachable" | "model_missing"`. Keep `"database" | "unknown"`.

| Kind | When | Message (Justino's voice; no vendor name) |
|---|---|---|
| `model_unreachable` | Embedding call can't reach Ollama or the proxy | "¡Auu! 🐶 Mi cerebro de perrito está tomando una siesta y no puedo responderte ahorita. Intenta en unos minutos, aquí te espero." |
| `model_missing` | Embedding model not installed (configuration error) | "¡Auu! 🐶 Algo de mi configuración no está listo. Avísale a mi equipo, por favor." |

Answer-model failures stay non-fatal: they fall back to the evidence answer, as they do today. **Embedding** failures remain fatal for the question, because nothing can be retrieved without them.

### Phase 5: Scripts

- `scripts/seedDocs.ts`, `scripts/uploadDocs.ts`, `scripts/repairChunks.ts`: replace `hf.featureExtraction` with `generateEmbedding()`. They run in Node, so they use `OLLAMA_BASE_URL`, which defaults to `http://localhost:11434`.
- New `scripts/checkEmbeddings.ts` (Phase 2) and optionally `scripts/reembed.ts`.
- New `scripts/ollamaSmoke.ts`: one embed call and one chat call with a fixed SENASICA question. Prints the latency and answer for each. Run it before every demo.

### Phase 6: Serving `/ollama` in dev and production

**Dev:** add a proxy in `vite.config.ts`:

```ts
server: {
  proxy: {
    "/ollama": { target: "http://localhost:11434", changeOrigin: true, rewrite: (p) => p.replace(/^\/ollama/, "") },
  },
},
```

**Production:** replace the unused `api/chat.ts` with a Vercel function `api/ollama/[...path].ts` (or one `api/ollama.ts` plus a rewrite in `vercel.json`). The function should:

- **Allow only** `POST /api/embed` and `POST /api/chat`. Ollama has no authentication, and endpoints like `/api/pull`, `/api/delete` and `/api/create` must never be reachable from the internet.
- **Allow only** the configured model names in the request body.
- Forward to `OLLAMA_UPSTREAM_URL`, adding `Authorization: Bearer ${OLLAMA_UPSTREAM_TOKEN}` when it's set. The token is checked by a reverse proxy (Caddy or nginx), or it's the API key for a hosted Ollama service.
- Enforce a maximum body size and set the function's `maxDuration` above `VITE_LLM_TIMEOUT_MS`. Check the limit for the Vercel plan.
- Optional: a basic per-IP rate limit, because the upstream is our own hardware.

`api/uploadPDF.ts` imports from `next`, which isn't a dependency of this Vite project. Leave it out of scope, but don't treat it as a working example.

### Phase 7: Remove Hugging Face

- `npm uninstall @huggingface/inference`
- Delete `lib/huggingface.ts` and the two `declare module` lines in `src/global.d.ts`.
- `env.d.ts`: remove `VITE_HF_*` and add the new variables ([§5](#5-environment-variables)).
- Remove `VITE_HF_*` from `.env` files and from the Vercel project settings.
- **Revoke the HF token.** It was public in the deployed bundle.
- Check: `grep -rniE "hugging|hf_|HfInference" --exclude-dir=node_modules --exclude-dir=dist .` returns only historical notes.

### Phase 8: Documentation

- `CURRENT.md`: update the architecture diagram, stack table, env var table and troubleshooting messages. Replace "Hugging Face is a mandatory project requirement" with the Ollama decision and link to this plan. Replace the HF credits known issue with the "Ollama host must be up" issue.
- `README.md` (ES and EN): replace "Hugging Face" in "how it works" and the stack line.
- Add a "Run locally" section: `ollama serve`, `ollama pull …`, `npm run dev`.

### Phase 9 (optional): Better Spanish retrieval

`all-MiniLM-L6-v2` was trained mostly on English, and the SENASICA documents and questions are in Spanish. Once the swap is stable, evaluate a multilingual embedding model available in Ollama, such as `nomic-embed-text` (768 dims) or `bge-m3` (1024 dims). This requires:

- A schema migration: a new `vector(N)` column or table, plus a new `match_documents`.
- A full re-embed.
- A small retrieval eval: 20 or more real questions, each with the chunk that should be retrieved, comparing hit@3 before and after.

Do this separately so that any change in answer quality can be traced to the right step.

---

## 4. Production hosting options

Ollama has to run somewhere the Vercel function can reach. The code is the same for every option; only `OLLAMA_UPSTREAM_URL` and the token change.

| Option | Cost | Latency (7B) | Availability | Fits |
|---|---|---|---|---|
| **A. Laptop + tunnel** (Cloudflare Tunnel or ngrok) | Free | Good on Apple Silicon (Metal) | Only while the laptop is on | Hackathon demo, development |
| **B. CPU VPS** | Low monthly cost | Slow for 7B. Use a 3–4B model (`gemma3:4b`, `qwen2.5:3b`). | Always on | Small public pilot |
| **C. GPU VM** (on demand) | Per hour; turn it off when not in use | Fast | When running | Demos with heavier models, LoRA serving |
| **D. Hosted Ollama-compatible API** | Varies; check current limits | Fast | Always on | If self-hosting is too much work. Check that the embedding model and the custom LoRA model are supported before choosing it. |

**Recommendation:** use **A** now. It's free, which is the reason for this migration, and it fits demo days. Build the proxy in Phase 6 so moving to **B** or **C** later only changes environment variables.

With option A, the deployed site **can't answer in-scope questions while the laptop is off**, because embeddings are required for retrieval. Greetings and out-of-scope replies still work. Be explicit about this in the README.

If the app needs retrieval when the model host is down, compute query embeddings in the browser with a WASM or ONNX build of MiniLM. That removes the embedding call from the server path. It's a separate decision and out of scope here.

---

## 5. Environment variables

| Variable | Where | Default | Purpose |
|---|---|---|---|
| `VITE_OLLAMA_BASE_URL` | Browser | `/ollama` | Base path the app calls. Leave it at the default in dev and prod. |
| `VITE_OLLAMA_EMBED_MODEL` | Browser and scripts | `all-minilm:22m` (pin after Phase 0) | Embedding model. **Must produce 384 dimensions** with the current schema. |
| `VITE_OLLAMA_CHAT_MODEL` | Browser | `qwen2.5:7b` | Answer model, tried first. Set to `justino` for the LoRA model. |
| `VITE_OLLAMA_FALLBACK_MODELS` | Browser | *(empty)* | Comma-separated fallback models |
| `VITE_LLM_MAX_MODEL_CALLS` | Browser | `2` | Most chat calls per question |
| `VITE_LLM_TIMEOUT_MS` | Browser | `60000` | Timeout per chat call |
| `OLLAMA_BASE_URL` | Scripts (Node) | `http://localhost:11434` | Direct Ollama URL for maintenance scripts |
| `OLLAMA_UPSTREAM_URL` | Vercel function only | none | Where the proxy forwards to (tunnel, VPS or GPU host) |
| `OLLAMA_UPSTREAM_TOKEN` | Vercel function only | none | Secret sent to the upstream's reverse proxy |
| `OLLAMA_ALLOWED_MODELS` | Vercel function only | embed and chat models | Allowlist the proxy enforces |

Removed: `VITE_HF_API_KEY`, `HF_API_KEY`, `VITE_HF_PROVIDER`, `VITE_HF_ANSWER_MODEL`, `VITE_HF_ENDPOINT_URL`, `VITE_HF_MAX_MODEL_CALLS`.

None of the new `VITE_*` values are secrets. The only secret, `OLLAMA_UPSTREAM_TOKEN`, stays on the server.

---

## 6. Choosing the answer model

Run the same evaluation for each candidate with `scripts/ollamaSmoke.ts`, extended to a list of questions:

- About 15 real in-scope questions, covering both directions: MX→US and US→MX.
- About 5 out-of-scope questions that should return the exact `SCOPE_REPLIES` text: cats, Canada, recipes.
- About 3 follow-ups that depend on history.

Score each candidate on: factual match with the retrieved chunks (no invented requirements), exact refusal text, Mexican Spanish and Justino's voice, and p50 and p95 latency on the target host.

| Candidate | Size | Notes |
|---|---|---|
| `qwen2.5:7b` | ~4.7 GB | Same model family as today's HF default. Strong Spanish. Best base for the LoRA. |
| `llama3.1:8b` | ~4.9 GB | Same family as today's second HF fallback |
| `gemma3:4b` | ~3.3 GB | Already installed. Fast. Good fallback, or primary on a CPU VPS. |

---

## 7. LoRA fine-tuned Justino on Ollama

The plan to fine-tune doesn't change. Only the serving step does:

1. Train the LoRA on the chosen base, for example `Qwen/Qwen2.5-7B-Instruct`, with the dataset built from `buildChatMessages()`, exactly as before.
2. Export for Ollama, either way:
   - **Merge, then convert:** merge the adapter into the base, convert to GGUF with llama.cpp, quantize to Q4_K_M, then use `FROM ./justino-q4_k_m.gguf`.
   - **Adapter only:** convert the adapter to GGUF (`convert_lora_to_gguf.py`), then use `FROM qwen2.5:7b` and `ADAPTER ./justino-lora.gguf`. **The base in `FROM` must be the exact base the adapter was trained on.**
3. `Modelfile`: don't add a `SYSTEM` line, because the app already sends the system prompt. Keep the base model's chat `TEMPLATE`.
4. Run `ollama create justino -f Modelfile` on the host, then set `VITE_OLLAMA_CHAT_MODEL=justino` and `VITE_OLLAMA_FALLBACK_MODELS=qwen2.5:7b`.
5. Run the evaluation from [§6](#6-choosing-the-answer-model) and compare against the base model.

Commit the `Modelfile` under `AgentJustino/ollama/` so the model is reproducible. Don't commit the weights.

---

## 8. Verification checklist

- [ ] `npm test` passes, including the new `lib/ollama.test.ts`
- [ ] `npm run build` passes, and the built bundle doesn't contain `huggingface`
- [ ] `scripts/checkEmbeddings.ts` shows similarity ≥ 0.99, or the in-place re-embed is done
- [ ] `scripts/ollamaSmoke.ts` passes against local Ollama
- [ ] Dev: an in-scope question returns `source: "model"`. The console logs the Ollama model name.
- [ ] Dev, Ollama stopped: the in-scope question returns the `model_unreachable` message. A greeting still works.
- [ ] Dev, chat model not pulled: falls back to the next model, then to the evidence answer
- [ ] Prod proxy: `POST /ollama/api/pull` is rejected. A model not in the allowlist is rejected.
- [ ] Prod: an in-scope question works end to end through the proxy
- [ ] HF token revoked. `VITE_HF_*` removed from Vercel.
- [ ] `CURRENT.md` and `README.md` updated

## 9. Rollback

All changes are in one branch and PR. To roll back, revert the merge commit. Supabase data isn't modified unless Phase 2 runs the re-embed. In that case the old vectors are overwritten, so export the `documents` table (Supabase dashboard → Table editor → Export CSV) **before** running `reembed.ts`.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Ollama host down: in-scope questions fail completely | Smoke test before demos. Clear message in Justino's voice. Move to an always-on host (§4 B or C) for public use. |
| Slow CPU inference causes timeouts and frequent evidence answers | Smaller model on CPU hosts, `keep_alive`, warm-up request, 60 s timeout |
| Prompt silently truncated by a small `num_ctx` | Always send `num_ctx: 4096` |
| Ollama exposed to the internet without authentication | Only reachable through the allowlisting proxy. The upstream requires a token. Never expose port 11434. |
| Embedding drift between HF and Ollama MiniLM | Phase 2 check before anything else changes |
| Weak retrieval for Spanish | Phase 9 multilingual embeddings, measured with an eval |
