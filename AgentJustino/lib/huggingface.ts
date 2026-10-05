import { HfInference } from "@huggingface/inference";

const nodeEnv = typeof process !== "undefined" ? process.env ?? {} : {};
const viteEnv = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};

export function resolveHfApiKey(): string {
  return (viteEnv.VITE_HF_API_KEY ?? nodeEnv.VITE_HF_API_KEY ?? nodeEnv.HF_API_KEY ?? "").trim();
}

export const hf = resolveHfApiKey() ? new HfInference(resolveHfApiKey()) : null;

export function ensureHfConfigured() {
  if (!hf) {
    throw new Error("Falta la configuración de Hugging Face. Revisa HF_API_KEY o VITE_HF_API_KEY.");
  }

  return hf;
}

