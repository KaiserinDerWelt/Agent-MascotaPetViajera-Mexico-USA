import { HfInference } from "@huggingface/inference";

export const hf = new HfInference(import.meta.env.VITE_HF_API_KEY!);

