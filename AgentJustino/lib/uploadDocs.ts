import { supabase } from "./supabase";
import { hf } from "./huggingface";

export async function uploadDocs(docs: string[]) {
  for (let i = 0; i < docs.length; i++) {
    const embedding = await hf.featureExtraction({
      model: "sentence-transformers/all-MiniLM-L6-v2",
      inputs: docs[i],
    });

    await supabase.from("documents").insert({
      content: docs[i],
      embedding: embedding[0], // vector generado
    });
  }
}

