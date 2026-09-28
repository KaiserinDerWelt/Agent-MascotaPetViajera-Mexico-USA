import { HfInference } from "@huggingface/inference";

const nodeEnv = typeof process !== "undefined" ? process.env ?? {} : {};
const viteEnv = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};
const hfApiKey = (viteEnv.VITE_HF_API_KEY ?? nodeEnv.VITE_HF_API_KEY ?? "").trim();

export const hf = hfApiKey ? new HfInference(hfApiKey) : null;

export function ensureHfConfigured() {
  if (!hf) {
    throw new Error("Falta la configuración de Hugging Face. Revisa VITE_HF_API_KEY.");
  }

  return hf;
}

