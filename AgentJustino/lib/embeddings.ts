import { hf } from "./huggingface";

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

export async function generateEmbedding(text: string) {
  const embedding = await hf.featureExtraction({
    model: "sentence-transformers/all-MiniLM-L6-v2",
    inputs: text,
  });

  return normalizeEmbedding(embedding);
}
