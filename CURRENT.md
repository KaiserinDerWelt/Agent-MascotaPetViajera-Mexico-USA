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

Entry point: `answerQueryWithMetadata(query)` in [`lib/chat.ts`](AgentJustino/lib/chat.ts), called by [`ChatUI.tsx`](AgentJustino/src/ChatUI.tsx).

1. **Embed the question:** `generateEmbedding()` calls HF `featureExtraction` with `sentence-transformers/all-MiniLM-L6-v2`.
2. **Retrieve:** `supabase.rpc("match_documents", { query_embedding, match_count: 3 })`.
3. **Post-process:** drop SENASICA page headers and footers, dedupe, split matches into 600-character chunks, re-rank them by keyword overlap with the question, and keep the top 4 as context.
4. **Generate:** HF `chatCompletion` with a Mexican-Spanish system prompt (`max_tokens: 180`, `temperature: 0.4`, `top_p: 0.9`, 15-second timeout per call).
   - Model order: `VITE_HF_ANSWER_MODEL` (if set), then `Qwen/Qwen2.5-7B-Instruct`, `meta-llama/Llama-3.1-8B-Instruct`, `mistralai/Mistral-7B-Instruct-v0.2`, `microsoft/Phi-3-mini-4k-instruct`, `Qwen/Qwen2.5-3B-Instruct`.
   - Each model is tried **twice**, rotating providers: `VITE_HF_PROVIDER` (if set), then `hf-inference`, then `featherless-ai`.
5. **Compose the answer:**
   - If the model answered: the cleaned model answer plus an "En resumen:" excerpt from the documents.
   - If no model answered: an answer built only from the retrieved text.

The result also carries metadata (`source`, `usedModel`, `fallback`, `chunkIds`). The chat shows it under each reply as either **"Respuesta generada con modelo"** or **"Respuesta basada en evidencia (modelo no disponible)"**.

### What the user sees when something fails

| Message in the chat | Cause |
|---|---|
| "No pude responder en este momento porque la conexión con la base documental o el modelo no está disponible…" | The embedding call or the Supabase client threw: missing keys, no HF credits (HTTP 402), or Supabase unreachable. Check the browser console for the real error. |
| "No pude consultar la base documental en este momento…" | `match_documents` returned an error (function missing, permissions, wrong vector size). |
| "No encontré información relevante en los documentos cargados…" | The search worked, but the `documents` table is empty or nothing matched. |
| Reply labeled "Respuesta basada en evidencia (modelo no disponible)" | Retrieval worked, but every answer model failed or timed out. |

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
| `VITE_HF_ANSWER_MODEL` | No | Answer model to try first, for example `Qwen/Qwen2.5-7B-Instruct` |
| `VITE_HF_PROVIDER` | No | HF inference provider to try first, for example `hf-inference` |

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
| **Hugging Face credits exhausted** (HTTP 402 "no remaining credits") | Every question fails at the embedding step | Free HF accounts get a small monthly credit. Each question makes 1 embedding call plus up to 10 answer-model calls (5 models × 2 tries). Uploads make 1 call per chunk. Check huggingface.co/settings/billing. |
| **Supabase project unreachable** (`opasocjuffdzerdyfqas.supabase.co` doesn't resolve) | No documents can be searched | Restore the project if it's paused. If it was deleted, recreate it with `schema.sql`, update the env vars, and re-upload the PDFs. |
| **API keys are public** | Anyone can copy the HF token and Supabase anon key from the deployed JavaScript | That's how `VITE_*` variables work. Together with the RLS policies, anyone can read, insert and delete documents. Acceptable for the hackathon demo. Before a public launch, move the HF calls and writes behind a serverless function. |
| Generic error message | The real cause is hidden in the chat | The outer `catch` in `lib/chat.ts` shows one message for every failure. The real error is in the browser console. |
| PDF uploader hidden | Documents can't be loaded from the deployed app | See §4. |
| Chunk `overlap` unused | Neighboring chunks don't overlap | `splitTextIntoChunks()` accepts `overlap` but ignores it. |
| Source PDFs not in the repo | A deleted database can't be rebuilt from the repo alone | Keep the SENASICA PDFs somewhere safe. |
| No tests or lint script | Changes aren't checked automatically | ESLint is configured, but there's no `npm run lint` yet. |
