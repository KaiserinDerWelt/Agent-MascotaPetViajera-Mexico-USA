import { supabase } from "./supabase";
import { hf } from "./huggingface";

// Recibe un array de textos (ej. PDFs convertidos a texto)
export async function uploadDocs(docs: string[]) {
  for (const doc of docs) {
    // 1. Generar embedding con Hugging Face
    const embedding = await hf.featureExtraction({
      model: "sentence-transformers/all-MiniLM-L6-v2",
      inputs: doc,
    });

    // 2. Insertar en Supabase
    const { error } = await supabase
      .from("documents")
      .insert({
        content: doc,
        embedding: embedding[0],
      });

    if (error) {
      console.error("Error al insertar documento:", error.message);
      throw error;
    }
  }
}
