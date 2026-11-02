-- Justino: Supabase schema for the RAG document store.
-- Run this once in Supabase Dashboard -> SQL Editor -> New query.
-- Safe to re-run: every statement is idempotent.

-- 1) Vector search extension (pgvector)
create extension if not exists vector with schema extensions;

-- 2) Documents table
--    Matches the app: inserts { content, embedding }, reads { id, content }.
--    embedding is 384 dims = sentence-transformers/all-MiniLM-L6-v2.
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

-- 4) Search function called by lib/chat.ts and api/chat.ts:
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
