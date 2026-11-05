import { ensureSupabaseConfigured } from "./supabase.ts";
import { generateEmbedding } from "./embeddings.ts";
import { splitDocumentsIntoChunks } from "./chunking.ts";

export async function uploadDocs(docs: string[]) {
  const supabaseClient = ensureSupabaseConfigured();
  const chunks = splitDocumentsIntoChunks(docs);

  if (!chunks.length) {
    throw new Error("El PDF no tiene contenido extraíble");
  }

  for (const chunk of chunks) {
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

    if (insertError) {
      const message = insertError.message || "Error desconocido al guardar en Supabase";
      throw new Error(`Supabase insert failed: ${message}`);
    }
  }
}
