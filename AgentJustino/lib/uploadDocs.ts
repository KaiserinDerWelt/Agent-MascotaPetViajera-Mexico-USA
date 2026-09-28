import { ensureSupabaseConfigured, supabase } from "./supabase";
import { ensureHfConfigured } from "./huggingface";
import { splitDocumentsIntoChunks } from "./chunking";

function normalizeEmbedding(value: unknown): number[] {
  if (Array.isArray(value)) {
    if (Array.isArray(value[0])) {
      return value[0] as number[];
    }

    if (value.every((item) => typeof item === "number")) {
      return value as number[];
    }
  }

  throw new Error("Invalid embedding format returned by Hugging Face");
}

export async function uploadDocs(docs: string[]) {
  const hf = ensureHfConfigured();
  const supabaseClient = ensureSupabaseConfigured();
  const chunks = splitDocumentsIntoChunks(docs);

  if (!chunks.length) {
    throw new Error("El PDF no tiene contenido extraíble");
  }

  for (const chunk of chunks) {
    let vector: number[];

    try {
      const embedding = await hf.featureExtraction({
        model: "sentence-transformers/all-MiniLM-L6-v2",
        inputs: chunk,
      });

      vector = normalizeEmbedding(embedding);
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo generar el embedding";
      throw new Error(`Fallo al generar el embedding: ${message}`);
    }

    if (!vector.length) {
      throw new Error("El embedding generado está vacío");
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
