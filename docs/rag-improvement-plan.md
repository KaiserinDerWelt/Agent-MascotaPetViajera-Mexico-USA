# Justino: RAG improvement plan

Status: **steps 0, 1, 3 and 4 are done**. The table now has 173 rows: 20 labelled SENASICA chunks and 153 directory rows. The cleanup was applied on 2026-11-12 through the SQL editor, which also added schema step 6. The table went from 798 to 195 rows.
Each step is measured with `npm run eval:retrieval` before and after.

## Diagnosis (2026-11-12)

| Finding | Value | Effect |
|---|---|---|
| Rows in `documents` | 798 | |
| Exact duplicate rows | **594** (204 unique) | The 3 search results are almost always the same chunk 3 times, so Justino reads 1 passage |
| Rows with requirements (not directory) | ~50 unique | This is the whole knowledge base |
| SENASICA vet directory (MVRA) | 152 unique rows | Lists of names, emails and phones as text chunks |
| Oversized rows | 6 (up to 92,246 chars) | Earlier uploads of the same pages before chunking; every piece already exists as its own chunk |
| Boilerplate-only rows | 3 | Legal disclaimer, share buttons |
| Content language | Almost all Spanish | `all-minilm` was trained mainly on English |
| Page headers inside chunks | Many chunks | "9/27/26, 7:06 PM Si viajas a Estados Unidos…" dominates some embeddings |
| `overlap` setting in `chunking.ts` | Accepted, never used | Information on a chunk boundary is split between chunks |

## Step 0: Measure — done

- `eval/retrieval-questions.json`: 34 questions (26 Spanish, 8 English), each with phrases the right passage must contain. **Add questions whenever you upload new documents.**
- `npm run eval:retrieval [-- --verbose] [-- --out eval/results/<name>.json]`: read-only.
  - It reports hit@1, hit@3 and hit@10 for vector search, plus MRR.
  - **App context** is the share of questions where the right passage reaches the text Justino reads (`retrieveContext` in `lib/chat.ts`, the same code the app runs).
  - **Unique in top 3** counts the distinct chunks among the first three results.

**Starting numbers** (`eval/results/baseline.json`, 798 rows, `all-minilm:22m`):

| | n | hit@1 | hit@3 | hit@10 | MRR | App context | Unique in top 3 |
|---|---|---|---|---|---|---|---|
| All | 34 | 6% | 6% | 26% | 0.09 | **6%** | 1.0 / 3 |
| Spanish | 26 | 8% | 8% | 31% | 0.12 | 8% | 1.0 / 3 |
| English | 8 | 0% | 0% | 13% | 0.03 | 0% | 1.0 / 3 |

## Step 1: Clean the data — done (2026-11-12)

`npm run clean-docs` always writes a backup first (`AgentJustino/backups/`, git-ignored) and, without `--yes`, changes nothing.

| Action | Rows |
|---|---|
| Delete exact duplicates (keep the oldest) | 594 |
| Delete oversized rows (verified: 0 pieces lost) | 6 |
| Delete boilerplate-only rows | 3 |
| **Result** | **798 → 195 rows** |

- **The live database does not let the anon key delete rows** (checked 2026-11-12: a delete returns 200 but removes nothing). Apply the cleanup in one of two ways:
  - **A.** Add `SUPABASE_SERVICE_ROLE_KEY` to `AgentJustino/.env` and run `npm run clean-docs -- --yes`. The script inserts before it deletes, and it fails loudly if fewer rows are deleted than planned.
  - **B.** Paste `backups/<file>.cleanup.sql`, which every dry run writes, into Supabase → SQL Editor → Run. It deletes exactly the planned rows or nothing, and also applies schema step 6.
- Undo: `npm run clean-docs -- --restore backups/<file>.json`.
- **Preventing new duplicates:**
  - `lib/uploadDocs.ts` skips chunks that already exist and chunks that are only boilerplate (`usefulText`), and reports the counts in the upload alert.
  - `supabase/schema.sql` step 6 adds a `content_hash` column with a unique index. Run it in the SQL editor **after** the cleanup.
- **Still open, step 1.4:** move the vet directory into its own table (state, municipality, name, contact) and look it up by state instead of by vector search. Decide what contact data Justino should show.
- **Result** (`eval/results/step1.json`, 195 rows):

| | hit@1 | hit@3 | hit@10 | MRR | App context | Unique in top 3 |
|---|---|---|---|---|---|---|
| All (34) | 6% | **24%** | **68%** | 0.22 | **24%** | **3.0 / 3** |
| Spanish (26) | 8% | 27% | 65% | 0.24 | 27% | 3.0 / 3 |
| English (8) | 0% | 13% | 75% | 0.18 | 13% | 3.0 / 3 |

The right passage is usually found, at 68% within the top 10, but rarely first: the top result is often a chunk made mostly of page header.

## Step 2: Source information per chunk

- Add `source_title`, `source_url`, `published_at`, `lang` and `doc_type` columns, filled in by the uploader.
- Answers can then cite their source. Updated SENASICA documents replace the old version instead of accumulating.

## Step 3: Better chunks — done (2026-11-12)

**Changes:**
- `lib/chunking.ts` was rewritten.
  - `prepareDocument` removes the gob.mx page chrome (masthead, print headers, link targets, share buttons, survey, disclaimer) and reads the page's title, date and URL.
  - Chunks are up to 900 characters. They split at sentence ends and at the gaps around headings, a chunk never ends on a heading, and the last ~150 characters repeat at the start of the next chunk. The `overlap` setting is finally used.
  - Every chunk starts with `[Title · SENASICA, date]`. The uploader uses the PDF's file name as the title when a page has none.
  - Emails, URLs and phone numbers are no longer broken by inserted spaces.
- **Bug fixed in `lib/chat.ts`:** `normalizeMatchContent` used `.*$`, which deleted all text after "Servicio Nacional…" or "Publicaciones Recientes", including requirements that followed a page header. Retrieved chunks are also no longer re-split to 600 characters. `MATCH_COUNT` is now 10.
- `scripts/reingestPages.ts` (`npm run reingest-pages -- --backup <file>`) is read-only. It rebuilds the chunks of the 5 SENASICA pages from the backup and checks that no sentence is lost. It then compares the current and new chunks offline, using the app's own ranking (`rankContext`), and writes `backups/<file>.reingest.sql`.

**Offline result** (34 questions; 42 old page chunks replaced by 20 new ones; the 153 directory rows are unchanged):

| | hit@3 | hit@10 | App context | English |
|---|---|---|---|---|
| Current chunks (live check: 53%) | 24% | 68% | 53% | 25% |
| **New chunks with title** | **47%** | **74%** | **68%** | 38% |
| New chunks without title | 44% | 71% | 65% | 50% |

With `MATCH_COUNT = 10`, the live app was at 59% before the `normalizeMatchContent` fix and 53% after it. On the old chunks, the buggy truncation happened to remove header noise. The new chunks no longer contain that noise.

**To apply:** paste `AgentJustino/backups/documents-2026-11-12T22-07-46-927Z.reingest.sql` into Supabase → SQL Editor → Run. It replaces exactly 42 rows with 20, or changes nothing. Then run `npm run eval:retrieval -- --out eval/results/step3.json`.

**Live result after the SQL** (`eval/results/step3.json`), matching the offline prediction:

| | hit@1 | hit@3 | hit@10 | MRR | App context |
|---|---|---|---|---|---|
| All (34) | 29% | 47% | 74% | 0.43 | **68%** |
| Spanish (26) | 31% | 50% | 81% | 0.45 | **77%** |
| English (8) | 25% | 38% | 50% | 0.33 | 38% |

From the start of this work (6%) to now (68%). Remaining misses: English questions, which are an embedding-model problem (steps 4 and 5). Also, the keyword re-ranking sometimes drops a correct first result: `mx-cert-contents` ranks first in vector search but doesn't reach the context (Step 4).

**Not done yet:**
- Heading-aware splitting only uses the gaps in the PDF text; real section detection needs the PDF layout.
- Links are removed from chunk text. Step 2 will store the page URL per chunk.
- The vet directory still uses the old chunks (step 1.4).

## Step 4: Better search — done (2026-11-12)

**Changes:**
- **Re-ranking** (`rankMatches` in `lib/chat.ts`): it now fuses the search order with a keyword order using reciprocal rank fusion. Before, the keyword score *replaced* the search order and threw away correct first results.
- **Spanish keywords** (`lib/searchTerms.ts`): stopwords are removed, a light stemmer matches word forms ("desparasitado" ≈ "desparasitados"), and a small **glossary** maps user wording to document wording (comida → alimento, renuevo → renovación, dura → vigencia, Europa/extranjero → otro país).
- **Hybrid search** (`supabase/schema.sql` step 7, applied 2026-11-12): `match_documents_hybrid` combines vector search with Postgres full-text search (`spanish` config), using RRF.
  - The generated `doc_type` column marks the SENASICA vet directory (153 rows), and new uploads are marked automatically. The directory is left out unless the question is about vets (`wantsDirectory`).
  - `retrieveContext` falls back to vector search with client-side filtering if the function is missing.
- The live project has no `extensions.vector`, so pgvector is likely in `public`. Step 7 uses an unqualified `vector` with `search_path = public, extensions`. Steps 1–4 of `schema.sql` still assume `extensions`.

**Held-out check questions:** 8 Spanish questions (`"set": "holdout"`) were written **before** tuning. They are never used to choose glossary entries or settings.

**Result** (`eval/results/step4-hybrid.json`, App context column). The hit@k columns of `eval:retrieval` still measure plain `match_documents`.

| | Before Step 4 | Re-ranking + directory filter | **+ hybrid search** |
|---|---|---|---|
| Spanish tuning questions (26) | 77% | 73% | **96%** |
| **Spanish held-out questions (8)** | 25% | 50% | **50%** |
| English (8) | 38% | 38% | 75% |
| All (42) | 60% | 62% | **83%** |

**Reading the numbers:** the tuning questions are nearly solved, but the held-out ones show the limit of a glossary. Remaining misses there are wording gaps the glossary doesn't cover: "parásitos" ↔ "desparasitados", "se venció" ↔ "renovación", "válido" ↔ "vigencia". Fixing them by adding those words would make the held-out set useless as a check. Options:
- Broaden the glossary from real user questions, then write a **new** held-out set.
- Use a multilingual embedding model (Step 5), which handles paraphrases without a glossary.

`mx-czi` dropped out of the context (its answer is 2nd in vector search). This is the cost of fusing in keyword order.

## Step 5: Multilingual embedding model (only if Step 0 shows a need)

- This requires `npm run reembed`.
- A different vector length also changes `vector(384)` in the schema.
- Choose the model by comparing `eval:retrieval` results.

## Step 6: Answers

- Add curated answers for the most common questions, then the guided checklist (direction, dates, vaccines). This step turns Justino into an agent.

## Security (alongside Step 1)

`supabase/schema.sql` gives the public anon key **insert and delete** permission on `documents`. **The live database is stricter: deletes with the anon key are blocked (checked 2026-11-12).** Whether anon inserts are allowed has not been checked. If they are, anyone with the anon key, which ships in the browser, can add content to the knowledge base. Bring `schema.sql` in line with the live policies, and move uploads to the server or require a sign-in.
