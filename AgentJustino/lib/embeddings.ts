import { EMBEDDING_DIMENSIONS, ollamaEmbed } from "./ollama.ts";

/** Embeds text with Ollama (all-minilm:22m by default). Must match the vector(384) column in Supabase. */
export async function generateEmbedding(text: string): Promise<number[]> {
  const [vector] = await ollamaEmbed(text);

  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `El modelo de embeddings devolvió ${vector.length} dimensiones; Supabase espera ${EMBEDDING_DIMENSIONS}. Revisa VITE_OLLAMA_EMBED_MODEL.`,
    );
  }

  return vector;
}
