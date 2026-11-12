-- Justino: Supabase schema for the RAG document store.
-- Run this once in Supabase Dashboard -> SQL Editor -> New query.
-- Safe to re-run: every statement is idempotent.

-- 1) Vector search extension (pgvector)
create extension if not exists vector with schema extensions;

-- 2) Documents table
--    Matches the app: inserts { content, embedding }, reads { id, content }.
--    embedding is 384 dims = all-MiniLM-L6-v2 (Ollama: all-minilm:22m).
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  embedding extensions.vector(384) not null,
  created_at timestamptz not null default now()
);

-- 3) Similarity index (cosine). HNSW works well on small/medium tables.
create index if not exists documents_embedding_idx
  on public.documents
  using hnsw (embedding extensions.vector_cosine_ops);

-- 4) Search function called by lib/chat.ts:
--    supabase.rpc("match_documents", { query_embedding, match_count })
create or replace function public.match_documents(
  query_embedding extensions.vector(384),
  match_count int default 3
)
returns table (
  id uuid,
  content text,
  similarity float
)
language sql
stable
set search_path = public, extensions
as $$
  select
    d.id,
    d.content,
    1 - (d.embedding <=> query_embedding) as similarity
  from public.documents d
  order by d.embedding <=> query_embedding
  limit match_count;
$$;

-- 5) Row Level Security
--    The app uses the public anon key from the browser, so anon needs
--    read + insert (PDF upload). Delete is only needed by scripts/repairChunks.ts.
--    NOTE: anyone with the anon key can do these actions. Fine for a hackathon
--    demo; tighten before going public.
alter table public.documents enable row level security;

drop policy if exists "documents_select_anon" on public.documents;
create policy "documents_select_anon"
  on public.documents for select
  to anon, authenticated
  using (true);

drop policy if exists "documents_insert_anon" on public.documents;
create policy "documents_insert_anon"
  on public.documents for insert
  to anon, authenticated
  with check (true);

drop policy if exists "documents_delete_anon" on public.documents;
create policy "documents_delete_anon"
  on public.documents for delete
  to anon, authenticated
  using (true);

grant execute on function public.match_documents(extensions.vector, int) to anon, authenticated;

-- 6) No duplicate chunks (added 2026-11-12; see docs/rag-improvement-plan.md, step 1).
--    Re-uploading a PDF used to store every chunk again (594 duplicate rows). A hash column that
--    Postgres fills in by itself + a unique index make that impossible; lib/uploadDocs.ts skips
--    chunks that hit it (error 23505). The app does not need to send content_hash.
--    Run AFTER `npm run clean-docs -- --yes`: creating the index fails while duplicates exist.
alter table public.documents
  add column if not exists content_hash text generated always as (md5(content)) stored;

create unique index if not exists documents_content_hash_key
  on public.documents (content_hash);

-- 7) Hybrid search: vector + Spanish full-text (added 2026-11-12; docs/rag-improvement-plan.md, step 4).
--    all-minilm is weak in Spanish: the answer to "¿Mi perro debe estar desparasitado?" ranked 34th
--    by vector alone. Full-text search with the Spanish stemmer matches "desparasitado" ↔
--    "desparasitados". Both rankings are merged with reciprocal rank fusion (RRF).
--    doc_type marks SENASICA's vet directory (MVRA list) automatically, also for new uploads,
--    so it stays out of answers unless the question is about vets (include_directory).
--    lib/chat.ts uses this function when it exists and falls back to match_documents otherwise.
--    The vector type is not schema-qualified: depending on how pgvector was installed it lives in
--    "extensions" (this file, step 1) or elsewhere: the live project has no extensions.vector (2026-11-12),
--    so it is most likely in "public". search_path covers both.
set search_path = public, extensions;
alter table public.documents
  add column if not exists doc_type text generated always as (
    case
      when content ~* '(DIRECTORIO DE MVRA|ESTADO\s+MUNICIPIO\s+NOMBRE)'
        or (length(content) - length(replace(content, '@', '')))
           - (length(content) - length(replace(lower(content), '@senasica', ''))) / 9 >= 2
      then 'directory'
      else 'page'
    end
  ) stored;

alter table public.documents
  add column if not exists fts tsvector generated always as (to_tsvector('spanish', content)) stored;

create index if not exists documents_fts_idx on public.documents using gin (fts);

create or replace function public.match_documents_hybrid(
  query_text text,
  query_embedding vector(384),
  match_count int default 10,
  include_directory boolean default false,
  rrf_k int default 20
)
returns table (id uuid, content text, similarity float, score float)
language sql
stable
set search_path = public, extensions
as $$
  with candidates as (
    select d.id, d.content, d.embedding, d.fts
    from public.documents d
    where include_directory or d.doc_type <> 'directory'
  ),
  semantic as (
    select c.id, row_number() over (order by c.embedding <=> query_embedding) as rank
    from candidates c
    order by c.embedding <=> query_embedding
    limit match_count * 2
  ),
  full_text as (
    select c.id,
           row_number() over (order by ts_rank_cd(c.fts, websearch_to_tsquery('spanish', query_text)) desc) as rank
    from candidates c
    where c.fts @@ websearch_to_tsquery('spanish', query_text)
    order by ts_rank_cd(c.fts, websearch_to_tsquery('spanish', query_text)) desc
    limit match_count * 2
  )
  select c.id,
         c.content,
         1 - (c.embedding <=> query_embedding) as similarity,
         coalesce(1.0 / (rrf_k + s.rank), 0) + coalesce(1.0 / (rrf_k + f.rank), 0) as score
  from semantic s
  full outer join full_text f on f.id = s.id
  join candidates c on c.id = coalesce(s.id, f.id)
  order by score desc
  limit match_count;
$$;

grant execute on function public.match_documents_hybrid(text, vector, int, boolean, int) to anon, authenticated;
