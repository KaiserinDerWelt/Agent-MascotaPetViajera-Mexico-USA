import { ensureSupabaseConfigured } from "./supabase.ts";
import { generateEmbedding } from "./embeddings.ts";
import { MIN_USEFUL_CHARS, splitDocumentsIntoChunks, usefulText } from "./chunking.ts";

/** Postgres unique_violation: raised by documents_content_hash_key once supabase/schema.sql step 6 is applied. */
const UNIQUE_VIOLATION = "23505";

export type UploadSummary = { inserted: number; duplicates: number; boilerplate: number };

/** `title` (e.g. the PDF file name) labels the chunks when the document has no gob.mx page title. */
export async function uploadDocs(docs: string[], title?: string): Promise<UploadSummary> {
  const supabaseClient = ensureSupabaseConfigured();
  const chunks = splitDocumentsIntoChunks(docs, title);

  if (!chunks.length) {
    throw new Error("El PDF no tiene contenido extraíble");
  }

  const summary: UploadSummary = { inserted: 0, duplicates: 0, boilerplate: 0 };

  for (const chunk of chunks) {
    if (usefulText(chunk).length < MIN_USEFUL_CHARS) {
      summary.boilerplate++;
      continue;
    }

    // Re-uploading the same PDF used to store every chunk again (594 duplicate rows by 2026-11).
    const { data: existing, error: lookupError } = await supabaseClient
      .from("documents")
      .select("id")
      .eq("content", chunk)
      .limit(1);

    if (lookupError) {
      throw new Error(`Supabase lookup failed: ${lookupError.message}`);
    }
    if (existing?.length) {
      summary.duplicates++;
      continue;
    }

    let vector: number[];

    try {
      vector = await generateEmbedding(chunk);
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo generar el embedding";
      throw new Error(`Fallo al generar el embedding: ${message}`, { cause: error });
    }

    const { error: insertError } = await supabaseClient
      .from("documents")
      .insert({
        content: chunk,
        embedding: vector,
      });

    if (insertError?.code === UNIQUE_VIOLATION) {
      summary.duplicates++;
      continue;
    }
    if (insertError) {
      const message = insertError.message || "Error desconocido al guardar en Supabase";
      throw new Error(`Supabase insert failed: ${message}`);
    }

    summary.inserted++;
  }

  return summary;
}
