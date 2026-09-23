import { hf } from "./huggingface";

export async function generateEmbedding(text: string) {
  const embedding = await hf.featureExtraction({
    model: "sentence-transformers/all-MiniLM-L6-v2",
    inputs: text,
  });
  return embedding[0];
}
