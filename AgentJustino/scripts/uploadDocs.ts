import { supabase } from "../lib/supabase";
import { hf } from "../lib/huggingface";
import { splitDocumentsIntoChunks } from "../lib/chunking";

export async function uploadDocs(docs: string[]) {
  const chunks = splitDocumentsIntoChunks(docs);

  for (const chunk of chunks) {
    const embedding = await hf.featureExtraction({
      model: "sentence-transformers/all-MiniLM-L6-v2",
      inputs: chunk,
    });

    const normalized = Array.isArray(embedding) && Array.isArray(embedding[0]) ? embedding[0] : embedding;

    await supabase.from("documents").insert({
      content: chunk,
      embedding: normalized,
    });
  }
}

