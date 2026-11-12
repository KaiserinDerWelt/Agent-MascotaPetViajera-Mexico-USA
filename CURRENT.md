# Justino: technical documentation

Current state of the project as of **November 5, 2026**. For the project's purpose and story, see the [README](README.md).

- **Production:** https://agent-mascota-pet-viajera-mexico-us.vercel.app/ (Vercel)
- **App code:** [`AgentJustino/`](AgentJustino/)
- **Database setup:** [`AgentJustino/supabase/schema.sql`](AgentJustino/supabase/schema.sql)

---

## 1. Architecture

Justino is a **single-page React app that runs the RAG pipeline in the browser**. Models run on **[Ollama](https://ollama.com)**:

- **Answers** come from **Ollama Cloud** (`https://ollama.com/api/chat`, model `glm-5.3-flash`). This needs `OLLAMA_API_KEY` **and prepaid usage credits**: Ollama Cloud is not free (see [§3.3](#33-ollama-cloud-credits-required-for-model-answers)).
- **Embeddings** come from a **self-hosted Ollama** (`all-minilm:22m`), because Ollama Cloud has no embedding models.

The browser always calls the same-origin path `/ollama/*` and never sees the API key. The server-side proxy [`lib/ollamaProxy.ts`](AgentJustino/lib/ollamaProxy.ts) sends `api/chat` to Ollama Cloud with `Authorization: Bearer $OLLAMA_API_KEY`, and `api/embed` to the self-hosted Ollama:

- **Development:** the Vite dev server runs that proxy (`vite.config.ts`). Embeddings go to `http://localhost:11434`.
- **Production:** `vercel.json` sends `/ollama/*` to the Vercel function [`api/ollama.ts`](AgentJustino/api/ollama.ts). Embeddings go to `OLLAMA_EMBED_UPSTREAM_URL` (see [§8](#8-development-and-deployment)).

```
Browser (React + MUI)
  │
  ├─ 1. Question ──► /ollama/api/embed   self-hosted Ollama, all-minilm:22m  → 384-dim vector
  │
  ├─ 2. Vector ────► Supabase  rpc("match_documents", match_count: 3)
  │                  pgvector cosine search over public.documents
  │
  ├─ 3. Local post-processing: dedupe → re-chunk (600 chars) → keyword re-rank → top 4 chunks
  │
  └─ 4. Prompt ────► /ollama/api/chat    Ollama Cloud: glm-5.3-flash → gpt-oss:20b
                     └─ on failure: answer built from the retrieved text
```

### Stack

| Layer | Technology |
|---|---|
| UI | React 19, Material UI 9, Emotion |
| Build | Vite 8, TypeScript 6 |
| Embeddings and LLM | Ollama (native `/api/embed` and `/api/chat`, called with `fetch`; no SDK) |
| Vector store | Supabase (Postgres + pgvector), `@supabase/supabase-js` 2 |
| PDF parsing | `pdfjs-dist` 6 (in the browser) |
| Hosting | Vercel (static Vite build + one proxy function, `api/ollama.ts`) |
| Model hosts | Ollama Cloud for answers; self-hosted Ollama for embeddings (see [§8](#8-development-and-deployment)) |

Justino used Hugging Face Inference Providers until November 2026. It moved to Ollama because Hugging Face no longer includes free credits. The migration plan and its reasoning are in [`docs/ollama-migration-plan.md`](docs/ollama-migration-plan.md).

---

## 2. Repository layout

```
.
├── README.md                 Project overview (ES/EN)
├── CURRENT.md                This file
├── docs/                     Design docs (Ollama migration plan)
├── MascotaPet.JPG
└── AgentJustino/             The app
    ├── index.html
    ├── vite.config.ts        Includes the dev proxy /ollama → localhost:11434
    ├── vercel.json           Production rewrite /ollama/* → api/ollama.ts
    ├── env.d.ts              Typed VITE_* environment variables
    ├── src/
    │   ├── main.tsx          React root + MUI theme
    │   ├── App.tsx           Page layout (PDF uploader currently commented out)
    │   ├── ChatUI.tsx        Chat window
    │   ├── PDFUploader.tsx   "Subir PDF" button (not mounted)
    │   ├── theme.ts
    │   └── assets/senasica-logo.png
    ├── lib/                  Core logic used by the app
    │   ├── chat.ts           RAG pipeline: answerQueryWithMetadata()
    │   ├── scope.ts          Operational scope guard (dogs, Mexico ↔ USA)
    │   ├── prompt.ts         System prompt + message format (shared with LoRA training)
    │   ├── scope.test.ts     Scope guard and prompt tests (npm test)
    │   ├── embeddings.ts     generateEmbedding()
    │   ├── ollama.ts         Ollama client: ollamaEmbed(), ollamaChat(), OllamaError
    │   ├── ollamaProxy.ts    Production proxy logic (path/model allowlist, limits)
    │   ├── ollama.test.ts    Client, proxy and model-selection tests (npm test)
    │   ├── supabase.ts       Supabase client + ensureSupabaseConfigured()
    │   ├── chunking.ts       Text cleanup and chunking
    │   ├── pdf.ts            readPDF() with pdfjs
    │   └── uploadDocs.ts     Chunk → embed → insert into Supabase
    ├── api/                  ollama.ts = production proxy; uploadPDF.ts = unused leftover (see §8)
    ├── scripts/              One-off maintenance scripts (see §6)
    └── supabase/schema.sql   Database schema
```

---

## 3. How a question is answered

Entry point: `answerQueryWithMetadata(query, history)` in [`lib/chat.ts`](AgentJustino/lib/chat.ts), called by [`ChatUI.tsx`](AgentJustino/src/ChatUI.tsx). The chat sends the last 6 messages as `history`, so follow-up questions work.

1. **Scope guard (no network, no model call):** `classifyQuery()` in [`lib/scope.ts`](AgentJustino/lib/scope.ts) decides whether the question is in scope. See [§3.1](#31-operational-scope).
   - Greetings, "¿qué puedes hacer?" and thanks get a fixed reply.
   - Out-of-scope questions get a fixed reply, chosen by the reason.
   - Only in-scope questions go on to step 2.
2. **Embed:** `generateEmbedding()` calls Ollama `/api/embed` with `all-minilm:22m` (all-MiniLM-L6-v2, 384 dimensions). For a follow-up ("¿y cuánto tarda?"), the previous question is included so the search has enough context.
3. **Retrieve:** `supabase.rpc("match_documents", { query_embedding, match_count: 3 })`.
4. **Post-process:** drop SENASICA page headers and footers, dedupe, split matches into 600-character chunks, re-rank them by keyword overlap with the question, and keep the top 4, numbered `[1]` to `[4]`.
5. **Generate:** Ollama `/api/chat` with the messages from `buildChatMessages()` in [`lib/prompt.ts`](AgentJustino/lib/prompt.ts): the system prompt, the last 4 turns, then the context and the question (`num_predict: 320`, `temperature: 0.3`, `top_p: 0.9`, `num_ctx: 4096`, `keep_alive: 30m`, 60-second timeout).
   - Models, in order (see [§3.2](#32-answer-model-and-lora-fine-tuned-model)): `VITE_OLLAMA_CHAT_MODEL` (default `glm-5.3-flash`), then `VITE_OLLAMA_FALLBACK_MODELS` (default `gpt-oss:20b`). Both are Ollama Cloud models. The list of cloud model names is at https://ollama.com/api/tags.
   - **One call per model, at most `VITE_LLM_MAX_MODEL_CALLS` (default 2) calls per question.** A missing model or a timeout moves on to the next model. These errors stop immediately, because every model on the account would fail the same way: unreachable, 401/403 (bad or missing key), 402 (no usage credits) and 429 (usage limit).
   - `num_ctx` is always set explicitly: Ollama's default context window is small and silently cuts the start of the prompt, which would remove the system prompt and the scope rules.
6. **Compose:**
   - If the model answered: the cleaned model answer. Line breaks are kept, so lists still show as lists.
   - If the model's reply is one of the scope refusals, it's labeled as out of scope.
   - If no model answered: up to 3 of the most relevant sentences from the retrieved text, followed by "confírmalo con SENASICA".

The result carries `source` (`model` | `evidence` | `guardrail` | `error`), `scope`, `usedModel`, `fallback`, `chunkIds` and `model`. Under each reply the chat shows "Respuesta generada con modelo", "Respuesta basada en evidencia (modelo no disponible)", "Fuera del alcance de Justino" or "Servicio no disponible". Greetings have no label.

### 3.1 Operational scope

**Justino only answers questions about traveling with dogs between Mexico and the USA**, in either direction. Two layers enforce this:

1. **`lib/scope.ts` (deterministic, runs first).** It matches keywords on normalized text: lowercase, no accents, no punctuation.

   | Decision | Rule | Reply |
   |---|---|---|
   | `greeting` / `thanks` | The whole message is a greeting, "¿qué puedes hacer?" or thanks | Introduction, or "¡Con gusto!" |
   | `out_of_scope` / `other_animal` | Mentions another species (gato, perico, conejo…) and no dog | "Por ahora solo puedo ayudarte con perros…" |
   | `out_of_scope` / `other_destination` | Mentions another country and not Mexico or the USA, in a travel or pet question | "Solo tengo información para viajar con perros entre México y Estados Unidos…" |
   | `in_scope` | Dog or pet + (travel, Mexico/USA, or paperwork word), **or** an animal-health term (SENASICA, rabia, microchip, zoosanitario…) + (travel or Mexico/USA) | Goes to RAG |
   | `in_scope`, `followUp` | Short follow-up ("¿y cuánto cuesta?") when one of the last 3 user turns was in scope | Goes to RAG with the previous question added |
   | `out_of_scope` / `off_topic` | Anything else, including "¿qué documentos necesito para viajar a USA?" with no pet mentioned | "Solo puedo responder preguntas sobre viajar con perros…" |

   Generic "mascota" or "pet" is accepted, and the answer covers dogs.

2. **System prompt (`lib/prompt.ts`).** It repeats the scope and tells the model to reply with the **exact same refusal sentences** when a question gets past the guard. It also tells the model to use only the reference text, never invent costs, deadlines or phone numbers, ask about the travel direction when it matters, and keep answers to 2–5 sentences in Mexican Spanish.

To change the scope, edit the patterns and `SCOPE_REPLIES` in `lib/scope.ts` and add cases to [`lib/scope.test.ts`](AgentJustino/lib/scope.test.ts).

### Justino's voice

Justino speaks as **a friendly pug who has made the trip between Mexico and the USA many times** and now explains SENASICA's rules to other families. The voice is defined in `SYSTEM_PROMPT` (`lib/prompt.ts`) and used in every fixed text: `SCOPE_REPLIES` in `lib/scope.ts`, the fallback answers and the error messages in `lib/chat.ts`, and the loading text in `ChatUI.tsx`.

- Speaks as a dog in the first person, uses "tú", and calls the pet "tu perrito" or "tu peludo".
- At most **one** dog expression ("¡Guau!", "mi olfato me dice", "moviendo la cola") and **one** emoji (🐶 or 🐾) per answer.
- **The personality never hides the rules:** requirements, deadlines and documents are stated exactly, without jokes.
- Problems that could stop the trip (an expired vaccine, a missing document) are stated clearly and calmly.
- When it helps, the answer ends with a practical tip or a short question.

Example of the target style:

> ¡Guau! Para que tu perrito entre a México desde Estados Unidos, lo más importante es que lleve su comprobante de vacuna antirrábica vigente 🐾. Al llegar, el personal de SENASICA en el aeropuerto o la frontera lo revisará. ¿Ya tienes su cartilla al día?

This example only shows the tone. The actual requirements must come from the SENASICA documents.

### 3.2 Answer model and LoRA fine-tuned model

The pipeline is ready for the fine-tuned Justino model. Only configuration is needed, no code changes:

1. Train the LoRA on the base model, for example `Qwen/Qwen2.5-7B-Instruct`, with the dataset described below.
2. Export it for Ollama: either merge the adapter and convert it to GGUF, or convert only the adapter to GGUF and load it with `ADAPTER`. A template is in [`AgentJustino/ollama/Modelfile.example`](AgentJustino/ollama/Modelfile.example).
3. On the Ollama host, run `ollama create justino -f Modelfile`.
4. Set `VITE_OLLAMA_CHAT_MODEL=justino` and `VITE_OLLAMA_FALLBACK_MODELS=glm-5.3-flash`. A custom model can't run on Ollama Cloud, so also set `OLLAMA_CHAT_UPSTREAM_URL` (server-side) to the self-hosted Ollama that serves it. In production, the proxy only allows these models (see `OLLAMA_ALLOWED_MODELS` in [§7](#7-configuration)).

If the fine-tuned model fails, the next model in the list is tried. Set `VITE_LLM_MAX_MODEL_CALLS=1` to use only the fine-tuned model. Don't put a `SYSTEM` line in the Modelfile: the app already sends the system prompt.

**Training data must use the same prompt format.** Build each example with `buildChatMessages(context, question, history)` from `lib/prompt.ts` and add the expected assistant reply as the last message. Include:
- in-scope questions in both travel directions, with SENASICA context
- follow-up questions
- questions whose answer isn't in the context, where the reply says so honestly
- out-of-scope questions, where the reply is **exactly** the matching `SCOPE_REPLIES` sentence

Every expected reply must be written in **Justino's voice** (see above), with requirements copied accurately from the context. The fine-tune is what makes the voice consistent. The prompt alone only gets part of the way with base models.

If the prompt or the replies change later, regenerate the dataset.

### 3.3 Ollama Cloud credits (required for model answers)

**Ollama Cloud is not free.** Model answers only work if the Ollama account that owns `OLLAMA_API_KEY` has usage credits. Without them, every chat request returns **HTTP 402**, and Justino falls back to answers built from the document text. Embeddings aren't affected: they run on the self-hosted Ollama, which is free.

#### Current state (checked 2026-11-11)

| Check | Result |
|---|---|
| `npm run ollama-balance` | Included allowance **$0.00 of $0.00** (period 2026-11-05 → 2026-12-05). Purchased credits **$0.00**. |
| Chat request to `glm-5.3-flash` | `402`: "Add usage credits or subscribe and save up to 66%: https://ollama.com/plans" |
| 12 other cloud models tried with the same key, on 2026-11-11 | `402` on all that exist (`gpt-oss:20b`, `gpt-oss:120b`, `gemma4:31b`, `deepseek-v4.1-flash`, `minimax-m3.1-flash`, `mimo-v2.6-flash`, `glm-5.3`, `kimi-k2.6`, `beam`, `muse-spark-open`). `nemotron-3-nano:30b` returned `410`. `clef:27b` returned `400`. |

So no cloud model is free on this account: a smaller or different model doesn't avoid the charge.

#### How Ollama Cloud billing works

From [ollama.com/pricing](https://ollama.com/pricing), checked 2026-11-11:

| Plan | Price | Included usage credits | Concurrent requests |
|---|---|---|---|
| **Pay as you go** | $0, no subscription | **None.** You buy usage credits and pay per token. | 3 |
| Pro | $20/month ($200/year) | $60 per month | 3 |
| Max | $100/month | $300 per month | 10 |

- Usage is billed **per token**, at a separate rate for input and output tokens that depends on the model.
- Ollama's [August 31, 2026 blog post](https://ollama.com/blog/transparent-pricing) said the free plan included "a small amount of monthly usage for a set of starter models". The current pricing page lists no such allowance, and this account's allowance is $0.00. **Don't rely on a free allowance.**
- Requests above the concurrency limit are queued. When the queue is full, they're rejected until a slot opens. Ollama doesn't document which status code it uses for this. Its [errors page](https://docs.ollama.com/api/errors) lists 429 for rate limits, which Justino reports as `rate_limited`.

#### What one Justino question costs

Measured on Justino's real prompt (`buildChatMessages()`: system prompt, 4 context chunks of up to 600 characters, the question, and up to 4 history turns):

- **Input:** about 5,100 characters with no history, or 6,400 with 4 history turns. That's about **1,250–1,600 tokens**, at the measured 4.1 characters per token for this Spanish text. Token counts vary slightly between model tokenizers.
- **Output:** at most **320 tokens** (`num_predict: 320` in `lib/chat.ts`).

| Model | Input / output price (USD per 1M tokens) | Max cost per answer (1,600 in + 320 out) | Answers per $1 (at that max) |
|---|---|---|---|
| `glm-5.3-flash` (default) | $0.15 / $0.50 | ≈ $0.00040 | ≈ 2,500 |
| `gpt-oss:20b` (fallback) | $0.07 / $0.30 | ≈ $0.00021 | ≈ 4,800 |

A question uses **at most 2 chat calls** (`VITE_LLM_MAX_MODEL_CALLS`), and the fallback only runs if the first model fails. Greetings, thanks and out-of-scope questions never call the model, so they cost nothing.

**Upper bound for a single abusive request:** the proxy limits the body to 64 KB (about 16,000 tokens) and output to 512 tokens. On `glm-5.3-flash` that's at most ≈ $0.0027 per request. The proxy also only allows the configured models, so a caller can't switch to an expensive one such as `kimi-k3` ($3.00 / $15.00 per 1M tokens).

#### Spending risk on the public site

Anyone who opens the deployed site can make Justino call the model, and the proxy has **no per-visitor rate limit**. With Pay as you go, spending can't go above the credits you bought, so buying a small amount works as a spending cap. Per-key cost budgets are only offered on the Enterprise plan.

#### How to enable model answers

1. Sign in at https://ollama.com with the account that owns `OLLAMA_API_KEY`.
2. Add usage credits (Pay as you go) or subscribe at https://ollama.com/plans.
3. Run `cd AgentJustino && npm run ollama-balance` and check that "Purchased credits" or "Included (plan) balance" is above $0.
4. Run `npm run smoke -- --chat-only`. It should print a model reply instead of `[credits 402]`.

No code change or redeploy is needed: the next question uses the credits.

#### Free alternative

Run the answer model on your own Ollama instead. For example, set `OLLAMA_CHAT_UPSTREAM_URL` to the same self-hosted Ollama used for embeddings, and `VITE_OLLAMA_CHAT_MODEL=gemma3:4b`. It costs nothing, but it only works while that machine is on, and answers are slower: about 20 seconds per answer on an Apple Silicon laptop once the model is loaded. See [§8](#8-development-and-deployment).

### What the user sees when something fails

| Message in the chat | Cause |
|---|---|
| "…Mi cerebro de perrito está tomando una siesta…" | The self-hosted Ollama is unreachable or timed out on the embedding call: Ollama isn't running, the tunnel or host is down, or `OLLAMA_EMBED_UPSTREAM_URL` isn't set in Vercel. |
| "…Algo de mi configuración no está listo…" | The embedding model isn't installed on the Ollama host. Run `ollama pull all-minilm:22m`. |
| "…no logré conectarme a la base de información de SENASICA…" | Supabase unreachable (paused project, wrong URL) or `match_documents` returned an error. |
| "Todavía no tengo información de SENASICA cargada…" | The search worked, but the `documents` table is empty. |
| Reply labeled "Respuesta basada en evidencia (modelo no disponible)" | Retrieval worked, but no answer model responded. The reason is logged in the browser console. |

The browser console shows the underlying error and its category (`model_unreachable`, `model_missing`, `database` or `unknown`). For an answer-model failure, it shows the Ollama error kind (`unreachable`, `model_missing`, `timeout`, `auth`, `credits`, `rate_limited`, `bad_response` or `http`). The answer then falls back to document text.

---

## 4. Loading documents (ingestion)

[`lib/uploadDocs.ts`](AgentJustino/lib/uploadDocs.ts):

1. `readPDF()` extracts the text from every page with pdfjs.
2. `splitDocumentsIntoChunks()` cleans the text and splits it on sentence boundaries into chunks of up to **600 characters**. Chunks under **120 characters** are discarded, and duplicates are removed.
3. Each chunk is embedded with `all-minilm:22m` (**one Ollama call per chunk**) and inserted into `public.documents`.

**The upload button is currently hidden.** `<PDFUploader />` is commented out in [`src/App.tsx`](AgentJustino/src/App.tsx). To load PDFs, uncomment it, run the app locally, upload, and comment it out again before deploying, since anyone using the deployed site could otherwise add documents.

---

## 5. Supabase setup

Run [`AgentJustino/supabase/schema.sql`](AgentJustino/supabase/schema.sql) once in **Supabase Dashboard → SQL Editor**. It can safely be run again. It creates:

| Object | Details |
|---|---|
| `vector` extension | pgvector, in the `extensions` schema |
| `public.documents` | `id uuid`, `content text`, `embedding vector(384)`, `created_at` |
| `documents_embedding_idx` | HNSW index, cosine distance |
| `public.match_documents(query_embedding vector(384), match_count int)` | Returns `id, content, similarity`, ordered by cosine distance |
| RLS policies | `anon` and `authenticated` can **select, insert and delete** |

The vector size **must be 384** to match `all-MiniLM-L6-v2`. The vectors already stored were made with Hugging Face's copy of that model, and they are **identical** to Ollama's `all-minilm:22m` (cosine similarity 1.0000 on a 20-row sample, checked with `npm run check-embeddings`), so no re-embedding was needed. Don't use `all-minilm:33m` (L12): it's also 384-dim, but it produces different vectors. If you change the embedding model, change the column and the function signature, and re-embed every document.

**Free-tier note:** Supabase pauses free projects after about a week of inactivity, and the app can't reach a paused project. Restore it from the dashboard and use it regularly before demos.

---

## 6. Maintenance scripts

These live in [`AgentJustino/scripts/`](AgentJustino/scripts/). Run them from `AgentJustino/`. Node 24 runs TypeScript directly, and the npm scripts load `.env`. Scripts call Ollama directly, not through `/ollama`. Chat goes to Ollama Cloud with `OLLAMA_API_KEY` from `.env`. Embeddings go to `OLLAMA_BASE_URL` (default `http://localhost:11434`).

| Command | What it does |
|---|---|
| `npm run smoke` | One embedding call and one chat call per answer model, with timings. Add `-- --chat-only` to test only Ollama Cloud. **Run it before every demo.** |
| `npm run ollama-balance` | Shows the Ollama Cloud credit balance for `OLLAMA_API_KEY` (`GET https://ollama.com/api/balance`). See [§3.3](#33-ollama-cloud-credits-required-for-model-answers). |
| `npm run check-embeddings` | Read-only. Re-embeds 20 stored rows and compares them with the stored vectors. Use it after changing the embedding model or Ollama version. |
| `npm run reembed -- --yes` | Re-embeds every row **in place** (update, never delete). Needs `SUPABASE_SERVICE_ROLE_KEY` in `.env`, because the anon key has no UPDATE policy. Export the `documents` table first. |
| `npm run seed-docs` | Inserts one test document. |
| `node --env-file=.env scripts/repairChunks.ts` | Re-chunks every row, **deletes all rows**, then re-embeds and re-inserts. If it fails halfway, data is lost. Prefer `reembed`. |
| `scripts/uploadDocs.ts`, `scripts/uploadPDF.ts` | Early versions of the ingestion code. `uploadDocs.ts` now re-exports `lib/uploadDocs.ts`. `uploadPDF.ts` uses a dummy file. |

---

## 7. Configuration

Create `AgentJustino/.env`. It's ignored by git, so never commit it.

| Variable | Required | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | Yes | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Yes | Supabase **anon public** key. Never use the `service_role` key here. |
| `VITE_OLLAMA_BASE_URL` | No | Base path the browser calls. Default `/ollama`. Leave it unset in dev and prod. |
| `VITE_OLLAMA_EMBED_MODEL` | No | Embedding model. Default `all-minilm:22m`. **Must produce 384 dimensions.** |
| `OLLAMA_API_KEY` | Yes | Ollama Cloud API key (ollama.com → Settings → API keys). The account needs usage credits ([§3.3](#33-ollama-cloud-credits-required-for-model-answers)). **Server-side only**: read by the Vite dev proxy, `api/ollama.ts` and scripts. **Never** prefix it with `VITE_`. |
| `VITE_OLLAMA_CHAT_MODEL` | No | Answer model, tried first. Default `glm-5.3-flash`. |
| `VITE_OLLAMA_FALLBACK_MODELS` | No | Comma-separated fallback models. Default `gpt-oss:20b`. |
| `VITE_LLM_MAX_MODEL_CALLS` | No | Most chat calls per question (default `2`) |
| `VITE_LLM_TIMEOUT_MS` | No | Timeout per chat call (default `60000`) |
| `OLLAMA_BASE_URL` | No | Scripts and the dev proxy only: self-hosted Ollama for embeddings. Default `http://localhost:11434`. |
| `OLLAMA_CHAT_BASE_URL` | No | Scripts only: send chat somewhere other than Ollama Cloud, for example `http://localhost:11434`. |
| `SUPABASE_SERVICE_ROLE_KEY` | No | `npm run reembed` only. **Never** prefix it with `VITE_`, or it ends up in the browser bundle. |

**Vercel only** (server-side, read by `api/ollama.ts`; not `VITE_*`, so never in the bundle):

| Variable | Required | Purpose |
|---|---|---|
| `OLLAMA_API_KEY` | Yes | Ollama Cloud API key for the answer model |
| `OLLAMA_EMBED_UPSTREAM_URL` | Yes | Self-hosted Ollama for embeddings, for example the Cloudflare Tunnel URL of the machine running Ollama. `OLLAMA_UPSTREAM_URL` is also accepted. |
| `OLLAMA_UPSTREAM_TOKEN` | Recommended | Sent as `Authorization: Bearer …` to the reverse proxy in front of the self-hosted Ollama |
| `OLLAMA_CHAT_UPSTREAM_URL` | No | Send chat somewhere other than `https://ollama.com`, for example a self-hosted Ollama serving the LoRA model |
| `OLLAMA_ALLOWED_MODELS` | No | Comma-separated model allowlist. Defaults to the embed, chat and fallback models above. |

None of the `VITE_*` values are secrets. The only secrets are `OLLAMA_API_KEY`, `OLLAMA_UPSTREAM_TOKEN` and `SUPABASE_SERVICE_ROLE_KEY`, and none of them reaches the browser. The old `VITE_HF_*` variables are no longer read. Remove them from `.env` and from Vercel.

Vite reads `.env` only when it starts. **Restart `npm run dev` after changing it.**

---

## 8. Development and deployment

### Local
```bash
# Once: install Ollama (https://ollama.com) and pull the models
ollama pull all-minilm:22m   # embeddings, ~46 MB (answers come from Ollama Cloud)
# add OLLAMA_API_KEY=<your key> to AgentJustino/.env

cd AgentJustino
npm install
npm run smoke     # check Ollama: local embedding + cloud chat
npm run dev       # http://localhost:5173 (/ollama: chat → Ollama Cloud, embed → localhost:11434)
npm run build     # production build into dist/
npm run preview   # serve the production build (no /ollama proxy, so no model answers)
npm test          # scope guard, prompt, Ollama client and proxy tests (no network)
```

### Vercel
- Production URL: **https://agent-mascota-pet-viajera-mexico-us.vercel.app/**
- Project settings: Framework **Vite**, Root Directory **`AgentJustino`**, Build Command `npm run build`, Output Directory `dist`.
- Add the `VITE_*` variables and the Vercel-only `OLLAMA_*` variables under **Settings → Environment Variables**, then **redeploy**. `VITE_*` values are built into the bundle, so changing them has no effect until the next deploy.
- `vercel.json` rewrites `/ollama/*` to `api/ollama.ts` and allows it to run for up to 90 seconds.

### Where Ollama runs in production

Answers come from Ollama Cloud, so production only needs `OLLAMA_API_KEY` for them. **Embeddings still need a self-hosted Ollama** that the Vercel function can reach. It only runs `all-minilm:22m` (23M parameters), so any small machine works. The code is the same for every option; only `OLLAMA_EMBED_UPSTREAM_URL` and the token change.

| Option | Cost | Notes |
|---|---|---|
| **Laptop + Cloudflare Tunnel or ngrok** (current choice) | Free | Works only while the laptop is on. Good for demos. |
| CPU VPS | Low monthly cost | Always on. A small CPU is enough for embeddings. |
| GPU VM | Per hour | Only needed to self-host the LoRA answer model. |

To set up the laptop option, run Ollama locally and expose it through a tunnel with a reverse proxy (Caddy or nginx) that checks the bearer token. Then set `OLLAMA_EMBED_UPSTREAM_URL`, `OLLAMA_UPSTREAM_TOKEN` and `OLLAMA_API_KEY` in Vercel. **Never expose port 11434 directly.** Ollama has no authentication, and its API can pull and delete models.

The proxy only forwards `POST /api/embed` and `POST /api/chat` for allowlisted models. It forces `stream: false` and caps `num_predict` at 512 and `num_ctx` at 8192.

### About `api/`
- `api/ollama.ts` is the production proxy described above. Its logic lives in `lib/ollamaProxy.ts` and is unit-tested.
- `api/uploadPDF.ts` is a leftover from an earlier design. It imports `next`, `formidable` and `pdf-parse`, which are not in `package.json`. Treat it as not working.

---

## 9. Known issues and limitations

| Issue | Impact | Notes |
|---|---|---|
| **Self-hosted Ollama must be up for embeddings** | While it's down or the tunnel is closed, in-scope questions fail at the embedding step. Greetings and out-of-scope replies still work. | Run `npm run smoke` before demos. For an always-on site, move the embedding Ollama to a small VPS (see [§8](#8-development-and-deployment)). |
| **Ollama Cloud has no credits** (HTTP 402 on every model) | Every in-scope answer falls back to document text. Greetings and out-of-scope replies still work. | Ollama Cloud is pay per token, with no free allowance on this account (checked 2026-11-11: $0.00 included, $0.00 purchased). Add credits, or self-host the answer model. See [§3.3](#33-ollama-cloud-credits-required-for-model-answers). |
| Ollama Cloud concurrency | Pay as you go and Pro allow 3 concurrent requests. Extra requests queue, and are rejected when the queue is full. | Rejected answers fall back to document text. Max allows 10. |
| **Supabase free-tier pausing** | No documents can be searched while the project is paused | The project was paused and has been restored. The documents survived. Use it regularly, and check it before demos. |
| **Supabase anon key is public** | Anyone can copy the Supabase anon key from the deployed JavaScript | That's how `VITE_*` variables work. Together with the RLS policies, anyone can read, insert and delete documents. Acceptable for the hackathon demo. Before a public launch, move writes behind a serverless function. Model access is already behind `api/ollama.ts`. |
| Scope guard is keyword-based | Unusual phrasings can be misclassified | Mitigated by the same rules in the system prompt. Add misclassified examples to `lib/scope.test.ts` and adjust the patterns. |
| LoRA model untested | The fine-tuned model hasn't been trained yet. Custom models can't run on Ollama Cloud. | It needs a self-hosted Ollama for chat (`OLLAMA_CHAT_UPSTREAM_URL`). See §3.2. |
| PDF uploader hidden | Documents can't be loaded from the deployed app | See §4. |
| Chunk `overlap` unused | Neighboring chunks don't overlap | `splitTextIntoChunks()` accepts `overlap` but ignores it. |
| Source PDFs not in the repo | A deleted database can't be rebuilt from the repo alone | Keep the SENASICA PDFs somewhere safe. |
| Limited automated checks | The RAG pipeline itself has no automated test | `npm test` covers the scope guard, the prompt, the Ollama client, model selection, error mapping and the proxy allowlist. `npm run smoke` and `npm run check-embeddings` need a live Ollama. There's no `npm run lint` yet. |
