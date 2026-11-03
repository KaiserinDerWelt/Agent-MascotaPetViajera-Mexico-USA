# Justino: technical documentation

Current state of the project as of **November 2, 2026**. For the project's purpose and story, see the [README](README.md).

- **Production:** https://agent-mascota-pet-viajera-mexico-us.vercel.app/ (Vercel)
- **App code:** [`AgentJustino/`](AgentJustino/)
- **Database setup:** [`AgentJustino/supabase/schema.sql`](AgentJustino/supabase/schema.sql)

---

## 1. Architecture

Justino is a **single-page React app that runs the whole RAG pipeline in the browser**. There is no backend in the request path: the browser calls Hugging Face and Supabase directly with the keys baked into the build.

```
Browser (React + MUI)
  │
  ├─ 1. Question ──► Hugging Face  featureExtraction
  │                  sentence-transformers/all-MiniLM-L6-v2  → 384-dim vector
  │
  ├─ 2. Vector ────► Supabase  rpc("match_documents", match_count: 3)
  │                  pgvector cosine search over public.documents
  │
  ├─ 3. Local post-processing: dedupe → re-chunk (600 chars) → keyword re-rank → top 4 chunks
  │
  └─ 4. Prompt ────► Hugging Face  chatCompletion (answer model)
                     └─ on failure: answer built from the retrieved text
```

### Stack

| Layer | Technology |
|---|---|
| UI | React 19, Material UI 9, Emotion |
| Build | Vite 8, TypeScript 6 |
| Embeddings and LLM | `@huggingface/inference` 4 (Hugging Face Inference Providers) |
| Vector store | Supabase (Postgres + pgvector), `@supabase/supabase-js` 2 |
| PDF parsing | `pdfjs-dist` 6 (in the browser) |
| Hosting | Vercel (static Vite build) |

Hugging Face is a **mandatory project requirement**. Don't replace it with other model providers.

---

## 2. Repository layout

```
.
├── README.md                 Project overview (ES/EN)
├── CURRENT.md                This file
├── MascotaPet.JPG
└── AgentJustino/             The app
    ├── index.html
    ├── vite.config.ts
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
    │   ├── scope.test.ts     Unit tests (npm test)
    │   ├── embeddings.ts     generateEmbedding()
    │   ├── huggingface.ts    HF client + ensureHfConfigured()
    │   ├── supabase.ts       Supabase client + ensureSupabaseConfigured()
    │   ├── chunking.ts       Text cleanup and chunking
    │   ├── pdf.ts            readPDF() with pdfjs
    │   └── uploadDocs.ts     Chunk → embed → insert into Supabase
    ├── api/                  Serverless handlers (not used by the frontend, see §8)
    ├── scripts/              One-off maintenance scripts (see §6)
    └── supabase/schema.sql   Database schema
```

---

## 3. How a question is answered

Entry point: `answerQueryWithMetadata(query, history)` in [`lib/chat.ts`](AgentJustino/lib/chat.ts), called by [`ChatUI.tsx`](AgentJustino/src/ChatUI.tsx). The chat sends the last 6 messages as `history`, so follow-up questions work.

1. **Scope guard (no network, no credits):** `classifyQuery()` in [`lib/scope.ts`](AgentJustino/lib/scope.ts) decides whether the question is in scope. See [§3.1](#31-operational-scope).
   - Greetings, "¿qué puedes hacer?" and thanks get a fixed reply.
   - Out-of-scope questions get a fixed reply, chosen by the reason.
   - Only in-scope questions go on to step 2.
2. **Embed:** `generateEmbedding()` calls HF `featureExtraction` with `sentence-transformers/all-MiniLM-L6-v2`. For a follow-up ("¿y cuánto tarda?"), the previous question is included so the search has enough context.
3. **Retrieve:** `supabase.rpc("match_documents", { query_embedding, match_count: 3 })`.
4. **Post-process:** drop SENASICA page headers and footers, dedupe, split matches into 600-character chunks, re-rank them by keyword overlap with the question, and keep the top 4, numbered `[1]` to `[4]`.
5. **Generate:** HF `chatCompletion` with the messages from `buildChatMessages()` in [`lib/prompt.ts`](AgentJustino/lib/prompt.ts): the system prompt, the last 4 turns, then the context and the question (`max_tokens: 320`, `temperature: 0.3`, `top_p: 0.9`, 20-second timeout).
   - Targets, in order (see [§3.2](#32-answer-model-and-lora-fine-tuned-model)): the fine-tuned endpoint or model if configured, then `Qwen/Qwen2.5-7B-Instruct`, `meta-llama/Llama-3.1-8B-Instruct`, `mistralai/Mistral-7B-Instruct-v0.2`.
   - **One call per target, at most `VITE_HF_MAX_MODEL_CALLS` (default 2) calls per question.** On a 402 (no credits) or 401/403 (bad token) error, it stops immediately, because every model on the account would fail the same way.
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

| Where the LoRA model is served | Set |
|---|---|
| **Dedicated HF Inference Endpoint** (TGI, either merged weights or a base model with the adapter loaded) | `VITE_HF_ENDPOINT_URL=https://<endpoint>.endpoints.huggingface.cloud`, plus `VITE_HF_ANSWER_MODEL=<adapter or model id>` if the endpoint serves more than one |
| **Merged model on the Hub**, served by an Inference Provider that supports it | `VITE_HF_ANSWER_MODEL=<user>/<model>` and `VITE_HF_PROVIDER=<provider>` (for example `featherless-ai`) |

If the fine-tuned model fails, the next target is the base `Qwen/Qwen2.5-7B-Instruct`. Set `VITE_HF_MAX_MODEL_CALLS=1` to use only the fine-tuned model.

**Training data must use the same prompt format.** Build each example with `buildChatMessages(context, question, history)` from `lib/prompt.ts` and add the expected assistant reply as the last message. Include:
- in-scope questions in both travel directions, with SENASICA context
- follow-up questions
- questions whose answer isn't in the context, where the reply says so honestly
- out-of-scope questions, where the reply is **exactly** the matching `SCOPE_REPLIES` sentence

Every expected reply must be written in **Justino's voice** (see above), with requirements copied accurately from the context. The fine-tune is what makes the voice consistent. The prompt alone only gets part of the way with base models.

If the prompt or the replies change later, regenerate the dataset.

### What the user sees when something fails

| Message in the chat | Cause |
|---|---|
| "…el servicio de modelos de Hugging Face no tiene créditos disponibles…" | HF returned 402. Add credits to the account that owns `VITE_HF_API_KEY`. |
| "…la conexión con Hugging Face no está configurada correctamente." | `VITE_HF_API_KEY` is missing or invalid (401/403). |
| "…no logré conectarme a la base de información de SENASICA…" | Supabase unreachable (paused project, wrong URL) or `match_documents` returned an error. |
| "Todavía no tengo información de SENASICA cargada…" | The search worked, but the `documents` table is empty. |
| Reply labeled "Respuesta basada en evidencia (modelo no disponible)" | Retrieval worked, but no answer model responded. The reason is logged in the browser console. |

The browser console shows the underlying error and its category (`hf_credits`, `hf_auth`, `database` or `unknown`).

---

## 4. Loading documents (ingestion)

[`lib/uploadDocs.ts`](AgentJustino/lib/uploadDocs.ts):

1. `readPDF()` extracts the text from every page with pdfjs.
2. `splitDocumentsIntoChunks()` cleans the text and splits it on sentence boundaries into chunks of up to **600 characters**. Chunks under **120 characters** are discarded, and duplicates are removed.
3. Each chunk is embedded with `all-MiniLM-L6-v2` (**one Hugging Face call per chunk**) and inserted into `public.documents`.

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

The vector size **must be 384** to match `all-MiniLM-L6-v2`. If you change the embedding model, change the column, the function signature, and re-embed every document.

**Free-tier note:** Supabase pauses free projects after about a week of inactivity, and the app can't reach a paused project. Restore it from the dashboard and use it regularly before demos.

---

## 6. Maintenance scripts

These live in [`AgentJustino/scripts/`](AgentJustino/scripts/). None of them has an npm script yet.

| Script | What it does |
|---|---|
| `repairChunks.ts` | Reads every row in `documents`, re-chunks it, **deletes all rows**, then re-embeds and re-inserts. Reads `.env` itself. It uses one Hugging Face call per chunk. |
| `seedDocs.ts` | Inserts one test document. |
| `uploadDocs.ts`, `uploadPDF.ts` | Early versions of the ingestion code that `lib/` replaced. `uploadPDF.ts` uses a dummy file. |

Run them from `AgentJustino/` with a TypeScript runner, for example `npx tsx scripts/repairChunks.ts`.

---

## 7. Configuration

Create `AgentJustino/.env`. It's ignored by git, so never commit it.

| Variable | Required | Purpose |
|---|---|---|
| `VITE_HF_API_KEY` | Yes | Hugging Face access token (Inference Providers permission) |
| `VITE_SUPABASE_URL` | Yes | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Yes | Supabase **anon public** key. Never use the `service_role` key here. |
| `VITE_HF_ENDPOINT_URL` | No | Dedicated HF Inference Endpoint for the answer model, such as the LoRA fine-tuned Justino. Tried first. |
| `VITE_HF_ANSWER_MODEL` | No | Hub model id for the answer model, such as the merged LoRA model. Tried first when no endpoint is set. |
| `VITE_HF_PROVIDER` | No | Inference provider for Hub models, for example `featherless-ai` or `hf-inference`. Defaults to HF automatic routing. |
| `VITE_HF_MAX_MODEL_CALLS` | No | Most chat-completion calls per question (default `2`) |

Vite reads `.env` only when it starts. **Restart `npm run dev` after changing it.**

---

## 8. Development and deployment

### Local
```bash
cd AgentJustino
npm install
npm run dev       # http://localhost:5173
npm run build     # production build into dist/
npm run preview   # serve the production build
npm test          # scope guard + prompt unit tests (no network, no HF credits)
```

### Vercel
- Production URL: **https://agent-mascota-pet-viajera-mexico-us.vercel.app/**
- Project settings: Framework **Vite**, Root Directory **`AgentJustino`**, Build Command `npm run build`, Output Directory `dist`.
- Add the same `VITE_*` variables under **Settings → Environment Variables**, then **redeploy**. `VITE_*` values are built into the bundle, so changing them has no effect until the next deploy.

### About `api/`
`api/chat.ts` and `api/uploadPDF.ts` are serverless handlers left over from an earlier design. The frontend doesn't call them.
- `api/chat.ts` uses `textGeneration` with `microsoft/Phi-3.5-mini-instruct`, not the `lib/chat.ts` pipeline.
- `api/uploadPDF.ts` imports `next`, `formidable` and `pdf-parse`, which are not in `package.json`.

Treat both as not working until they're either removed or connected to the app.

---

## 9. Known issues and limitations

| Issue | Impact | Notes |
|---|---|---|
| **Hugging Face has no credits** (HTTP 402 "no remaining credits") | In-scope questions fail at the embedding step. Greetings and out-of-scope replies still work. | Free accounts no longer include a monthly Inference Providers credit, so a payment method or prepaid credits are required. Each in-scope question costs 1 embedding call plus at most 2 answer-model calls. Uploads cost 1 call per chunk. Check huggingface.co/settings/billing. |
| **Supabase free-tier pausing** | No documents can be searched while the project is paused | The project was paused and has been restored. The documents survived. Use it regularly, and check it before demos. |
| **API keys are public** | Anyone can copy the HF token and Supabase anon key from the deployed JavaScript | That's how `VITE_*` variables work. Together with the RLS policies, anyone can read, insert and delete documents. Acceptable for the hackathon demo. Before a public launch, move the HF calls and writes behind a serverless function. |
| Scope guard is keyword-based | Unusual phrasings can be misclassified | Mitigated by the same rules in the system prompt. Add misclassified examples to `lib/scope.test.ts` and adjust the patterns. |
| End-to-end model answers untested | The model and LoRA path hasn't run against a live model yet | Blocked by HF credits. The guard, prompt format, error handling and build are verified. |
| PDF uploader hidden | Documents can't be loaded from the deployed app | See §4. |
| Chunk `overlap` unused | Neighboring chunks don't overlap | `splitTextIntoChunks()` accepts `overlap` but ignores it. |
| Source PDFs not in the repo | A deleted database can't be rebuilt from the repo alone | Keep the SENASICA PDFs somewhere safe. |
| Limited automated checks | Only the scope guard and prompt have tests | `npm test` covers `lib/scope.ts` and `lib/prompt.ts`. There's no `npm run lint` yet. |
