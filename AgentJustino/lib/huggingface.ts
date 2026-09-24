import { HfInference } from "@huggingface/inference";

const hfApiKey = import.meta.env.VITE_HF_API_KEY as string;

if (!hfApiKey) {
  throw new Error("Missing Hugging Face API key. Check VITE_HF_API_KEY.");
}

export const hf = new HfInference(hfApiKey);

