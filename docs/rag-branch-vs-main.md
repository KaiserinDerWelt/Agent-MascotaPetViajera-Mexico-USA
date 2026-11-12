# Justino: RAG in `feature/RAG-Fine-Tunning-As-Fallback` vs `main`

*Status as of 2026-11-12.*
- **`main`** is at `3fef7c9`, after pull request #11 merged the Ollama migration.
- **This branch** is `main`'s code plus the RAG work described in [rag-improvement-plan.md](rag-improvement-plan.md). That work isn't pushed yet.

## Summary

- **Both versions now run on Ollama**: embeddings with `all-minilm:22m`, and the chat model through the server-side `/ollama` proxy. They also share the same prompt, scope guard and Supabase database. **The only difference is how Justino finds and quotes the documents.**
- **`main`** keeps the original retrieval:
  - 3 vector-search results,
  - a keyword score that replaces the vector order,
  - the old chunking and the old fallback answer.
- **This branch** adds:
  - hybrid search (vector plus Spanish full-text),
  - better re-ranking,
  - re-chunked SENASICA pages,
  - a vet-directory filter,
  - a better fallback answer with sources,
  - a fix for replies to Justino's greeting question.
- **Measured on the same data, with the same 42 questions run through each version's full app:** the right passage reaches Justino for **29%** of questions on `main` and **69%** on this branch.
- **"Fine-tuning" here means tuning the retrieval pipeline. No model has been fine-tuned yet.** Both versions contain the same hooks for a LoRA model (section 3).

## 1. Terms

| Term | Meaning in this project |
|---|---|
| **RAG** (retrieval-augmented generation) | Justino looks up the relevant passages in the SENASICA documents stored in Supabase, then answers from those passages. |
| **Retrieval** | Finding those passages: *embedding* the question (turning it into a vector), then *vector search* (finding the most similar stored chunks) and/or *keyword search*. |
| **Chunk** | A piece of a document stored with its embedding. |
| **Fine-tuning (LoRA)** | Training a small adapter on top of a base model, such as Qwen2.5-7B, so that it answers in Justino's voice and format. |
| **Retrieval tuning** | What this branch actually did: changing the data, chunking and search so the right passage is found. No model training is involved. |
| **Fallback answer** | When no chat model is available, Justino answers by quoting the most relevant sentences of the retrieved passages. This is the "As-Fallback" in the branch name. |

## 2. How each version answers a question

Steps 1, 2 and 5 are the same in both versions:
- **Step 1:** the scope guard (`lib/scope.ts`) handles greetings, off-topic questions and other species.
- **Step 2:** the question is embedded with Ollama `all-minilm:22m`.
- **Step 5:** an optional chat model through the `/ollama` proxy. The default is `glm-5.3-flash` on Ollama Cloud, which needs prepaid credits.

| Step | `main` | This branch |
|---|---|---|
| 1. Scope guard | Rejects a reply to Justino's greeting question ("de México a Estados Unidos") as off-topic | Understands that reply and detects the trip direction |
| 3. Search | `match_documents`: vector only, **3** results, vet directory included | `match_documents_hybrid`: vector plus Postgres **Spanish full-text search**, merged with reciprocal rank fusion. **10** candidates. The vet directory is included only for questions about vets. |
| 4. Re-ranking | A keyword overlap score **replaces** the vector order | The keyword order is **fused** with the search order, using Spanish stopwords, light stemming and a small glossary (comida → alimento). The best 4 are kept. |
| 6. Answer without a model (current state) | 3 sentences chosen by exact word overlap | 3 sentences chosen with the same Spanish matching as search. Long PDF run-ons are split, direction answers only quote the page for that direction, and a **"Fuente:"** line gives the page title and date. |

## 3. Fine-tuning status (LoRA)

After the merge, the fine-tuning path is **identical in both versions**:

| | `main` and this branch |
|---|---|
| Trained LoRA model | None yet |
| How a fine-tuned model would be served | Self-hosted Ollama using `ollama/Modelfile.example`: base `qwen2.5:7b` plus a GGUF adapter, with `VITE_OLLAMA_CHAT_MODEL=justino`. Ollama Cloud can't run custom models. |
| Prompt format shared with the training data | `lib/prompt.ts` (`buildChatMessages`) |
| Status | The base-model path was verified end to end with local `gemma3:4b`. The LoRA path is untested. |

The retrieval work in this branch is a **precondition** for fine-tuning, not an alternative to it. A fine-tuned model writes a better answer only if it receives the right passages.

## 4. What this branch changed, and the measured effect

All numbers come from the same 42 questions in `eval/retrieval-questions.json`: 26 Spanish questions used for tuning, 8 Spanish **held-out** questions written before tuning and never used to tune, and 8 English questions.

### 4.1 `main` vs this branch, today, on the same data

Each version's full app (`answerQueryWithMetadata`) was run on every question. A question counts when one of the passages Justino reads contains the answer.

| Questions | `main` | This branch |
|---|---|---|
| All (42) | 29% | **69%** |
| Spanish, tuning (26) | 31% | **77%** |
| Spanish, held-out (8) | 13% | **38%** |
| English (8) | 38% | **75%** |

`main` already benefits from the cleaned data (section 6). On the data as it was before this work, the same retrieval logic scored about 6%.

### 4.2 Step by step (search only, `npm run eval:retrieval`)

This benchmark skips the scope guard, so its numbers are higher than in 4.1.

| Change | Rows | Right passage in context |
|---|---|---|
| Starting point (`main`'s retrieval logic, original data) | 798 | **6%** |
| Step 1: remove 594 exact duplicates, 6 oversized rows and 3 boilerplate rows (backed up; nothing lost) | 195 | 24% |
| Fetch 10 results instead of 3 | 195 | 53% |
| Step 3: re-chunk the 5 SENASICA pages (page chrome removed, headings kept, overlap, `[Title · SENASICA, date]` label) | 173 | 68% |
| Step 4: fused re-ranking, directory filter, hybrid Spanish search, glossary | 173 | **83%** |

### 4.3 Known gap in both versions: the scope guard

The guard rejects **7 of the 42** questions before search runs, which explains the difference between 83% (search alone) and 69% (the whole app):
- **6 are wrongly blocked:** ticks, PMVF registration, CERTUR, the PMVF phone number, an expired PMVF, and "si vengo de otro país". None contains a dog or travel keyword the guard recognizes.
- **1 is blocked by design:** "Me mudo a España…". Justino only covers Mexico ↔ US.

The guard code is the same in `main` and in this branch. Making it accept SENASICA-specific terms (PMVF, CERTUR, garrapata) is the next fix.

### 4.4 Other changes in this branch

- **Uploads:** duplicates and boilerplate are skipped. The database rejects duplicate chunks through a unique `content_hash`, and new chunks are labelled with the PDF's title.
- **Bug fixes:**
  - The header cleanup deleted the requirement text that followed a page header.
  - Retrieved chunks were re-split to 600 characters.
  - The fallback answer showed raw labels and ignored the Spanish matching.
- **Tests:** 34 automated tests, a repeatable retrieval benchmark (`eval/`), and the scripts `clean-docs` and `reingest-pages`, each with a backup and a dry run.

## 5. Comparison

| Aspect | `main` | This branch | Advantage |
|---|---|---|---|
| Right passage reaches Justino (same data, 42 questions) | 29% | 69% | **Branch** |
| Questions phrased differently than the documents (held-out) | 13% | 38% | **Branch** |
| Search method | Vector only; `all-minilm` is weak in Spanish | Vector plus Spanish full-text (stemming), fused | **Branch** |
| Use of the vector ranking | Discarded by the keyword re-ordering (correct first results can be lost) | Fused with keywords | **Branch** |
| Vet directory (153 rows of names, emails and phones) | Competes with requirements in every search | Only for questions about vets | **Branch** |
| Reply to the greeting question ("de México a Estados Unidos") | Rejected as off-topic | Answered with the requirements for that direction | **Branch** |
| Answer without a model | Sentences by exact word overlap; can quote the wrong direction; no source | Direction-aware sentences with a "Fuente:" line | **Branch** |
| Uploads | Re-uploading a PDF now **stops with an error** at the first duplicate (section 6) | Duplicates and boilerplate skipped, with a summary | **Branch** |
| Measurability | No benchmark | `eval:retrieval`, including held-out questions | **Branch** |
| Database dependencies | Only `match_documents` | Also needs `schema.sql` step 7 (`match_documents_hybrid`, `doc_type`, `fts`); falls back to vector search without it | **`main`**: fewer database requirements |
| Code to maintain | Less code, no hand-written rules | Adds a stemmer, a stopword list, a glossary and a direction detector, which need upkeep as documents change | **`main`**: simpler |
| Released | Merged; it's the reference version | Not pushed or reviewed yet | **`main`** |
| Model provider, proxy, key handling, LoRA path | Ollama (identical) | Ollama (identical) | Tie |

## 6. Shared database: what `main` sees now

Both versions read **the same Supabase project**, so this branch's data changes already apply to `main`:
- **`main` searches the cleaned data:** 173 rows instead of 798, with no duplicates and the new labelled page chunks. That's why `main` now scores 29% instead of about 6%. It uses that data with its own weaker search: 3 results, keyword re-ordering, and the directory included.
- **The new columns are additive.** `content_hash`, `doc_type`, `fts` and `match_documents_hybrid` don't break `main`.
- **One behavior changes in `main`:** re-uploading a PDF **stops with an error** at the first duplicate chunk, because of the unique `content_hash`.
- **Rollback:** the full original table (798 rows with embeddings) is in `AgentJustino/backups/`, and `npm run clean-docs -- --restore <file>` brings it back.

## 7. Why both versions are in the repo

After the Ollama merge, the two versions differ only in the RAG layer. Both exist for these reasons:
1. **`main` is the reviewed, merged baseline; this branch is the candidate.** Its changes are larger than the provider switch: new SQL, new chunking and new answer logic. They should go through a pull request and a deployment check before replacing the baseline.
2. **Side-by-side measurement.** Section 4.1 compares both versions' code on the same data and the same questions. That only works while both exist, and it's the evidence for the merge decision.
3. **Rollback without data changes.** The database is shared and the branch's changes are additive, so the deployed site can go back to `main`'s code at any time without touching the data.

**Inside this branch, the two answer modes (model and quoted fallback) are complementary, not duplicates.**
- The quoted answer guarantees a correct, sourced reply even with no model, no Ollama Cloud credits, or a model outage.
- The model adds fluency and synthesis when available.

This is intentional and should stay after merging.

**Not intended:** keeping two RAG versions long term. Once this branch is merged, `main` has one retrieval pipeline and the old one remains in git history.

## 8. History: Hugging Face → Ollama (pull request #11, merged)

| | Before (Hugging Face) | Now (Ollama, in both versions) |
|---|---|---|
| Cost | Paid Inference credits for both embeddings and chat | Embeddings free (self-hosted Ollama); chat on Ollama Cloud at about $0.0004 per answer, or free when self-hosted |
| API key | Token bundled into the browser (`VITE_HF_API_KEY`) | `OLLAMA_API_KEY` stays on the server (`/ollama` proxy with a model allowlist and limits) |
| Embeddings | `sentence-transformers/all-MiniLM-L6-v2` | `all-minilm:22m`: the same vectors, so no re-embedding was needed |
| Fine-tuned model hosting | Managed: Hugging Face Inference Endpoint | Self-hosted Ollama only |

Details: [ollama-migration-plan.md](ollama-migration-plan.md).

## 9. Next steps

1. Commit and push this branch, then open a pull request to `main` with this document.
2. **Fix the scope guard** for SENASICA-specific questions (section 4.3). It affects both versions.
3. Before deploying, check that the Vercel deployment has `OLLAMA_API_KEY` and a reachable embedding upstream (`OLLAMA_EMBED_UPSTREAM_URL`). The deployment of the merged `main` hasn't been verified.
4. Make uploads go through the server, or require sign-in. `schema.sql` allows the public key to insert into `documents`. This hasn't been verified on the live project, which already blocks deletes.
5. Remaining retrieval work ([rag-improvement-plan.md](rag-improvement-plan.md)):
   - Step 1.4: move the vet directory to its own table.
   - Step 2: store the source URL per chunk.
   - Step 5: try a multilingual embedding model for paraphrases such as "parásitos" ↔ "desparasitados".
6. Train the LoRA only after that, with a dataset built from `buildChatMessages()`, and measure it against the same questions.
