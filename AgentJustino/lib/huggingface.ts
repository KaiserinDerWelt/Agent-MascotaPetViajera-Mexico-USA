import { HfInference } from "@huggingface/inference";

const hfApiKey = (import.meta.env.VITE_HF_API_KEY ?? "").trim();

export const hf = hfApiKey ? new HfInference(hfApiKey) : null;

export function ensureHfConfigured() {
  if (!hf) {
    throw new Error("Falta la configuración de Hugging Face. Revisa VITE_HF_API_KEY.");
  }

  return hf;
}

