import { generateEmbedding } from "./embeddings";
import { ensureSupabaseConfigured } from "./supabase";
import { ensureHfConfigured } from "./huggingface";

const DEFAULT_ANSWER_MODELS = [
  "microsoft/Phi-3.5-mini-instruct",
  "mistralai/Mistral-7B-Instruct-v0.2",
  "meta-llama/Llama-3.2-3B-Instruct",
  "google/gemma-2-2b-it",
  "google/flan-t5-base",
];

function normalizeGeneratedText(result: unknown): string {
  if (typeof result === "string") {
    return result.trim();
  }

  if (Array.isArray(result) && result.length > 0 && typeof result[0] === "string") {
    return result[0].trim();
  }

  if (result && typeof result === "object") {
    const candidate = (result as { generated_text?: unknown; text?: unknown }).generated_text ?? (result as { generated_text?: unknown; text?: unknown }).text;
    if (typeof candidate === "string") {
      return candidate.trim();
    }

    if (Array.isArray(candidate) && candidate.length > 0 && typeof candidate[0] === "string") {
      return candidate[0].trim();
    }
  }

  return "";
}

function sanitizeModelAnswer(answer: string): string {
  return answer
    .replace(/^(respuesta|answer|resumen|summary)\s*[:\-]?\s*/i, "")
    .replace(/^(según\s+el\s+contexto|based\s+on\s+the\s+context)\s*[:\-]?\s*/i, "")
    .replace(/\b(contexto|pregunta)\s*[:\-]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildHybridAnswer(matches: Array<{ content: string }>, modelAnswer?: string): string {
  const fallbackExcerpt = matches[0]?.content
    .replace(/\s+/g, " ")
    .trim();

  const shortSource = fallbackExcerpt ? (fallbackExcerpt.length > 220 ? `${fallbackExcerpt.slice(0, 220).trim()}...` : fallbackExcerpt) : "";
  const cleanedAnswer = modelAnswer ? sanitizeModelAnswer(modelAnswer) : "";

  if (cleanedAnswer) {
    return `${cleanedAnswer} Se puede corroborar con los documentos: ${shortSource}`;
  }

  if (shortSource) {
    return `Según los documentos consultados, la información clave es: ${shortSource}`;
  }

  return "No encontré información relevante en los documentos cargados para responder tu pregunta.";
}

async function tryGenerateModelAnswer(hf: { textGeneration: (params: any) => Promise<unknown> }, prompt: string, chosenModels: string[]): Promise<string> {
  for (const modelName of chosenModels) {
    try {
      const completion = await hf.textGeneration({
        model: modelName,
        inputs: prompt,
        parameters: {
          max_new_tokens: 180,
          temperature: 0.3,
          top_p: 0.9,
          do_sample: false,
          return_full_text: false,
        },
      });

      const answer = normalizeGeneratedText(completion);
      const cleanedAnswer = answer ? sanitizeModelAnswer(answer) : "";

      if (cleanedAnswer && cleanedAnswer.length > 0) {
        return cleanedAnswer;
      }
    } catch (error) {
      console.warn(`HF model failed for ${modelName}:`, error);
    }
  }

  return "";
}

export async function answerQueryFromDocuments(query: string): Promise<string> {
  const cleanedQuery = query.trim();

  if (!cleanedQuery) {
    throw new Error("La pregunta está vacía");
  }

  const embedding = await generateEmbedding(cleanedQuery);
  const supabaseClient = ensureSupabaseConfigured();

  const { data, error } = await supabaseClient.rpc("match_documents", {
    query_embedding: embedding,
    match_count: 3,
  });

  if (error) {
    throw new Error(`No pude consultar los documentos: ${error.message}`);
  }

  const matches = (data ?? []) as Array<{ content: string }>;

  if (!matches.length) {
    return "No encontré información relevante en los documentos cargados para responder tu pregunta.";
  }

  const context = matches.map((entry) => entry.content).join("\n\n");
  const configuredModel = (import.meta.env.VITE_HF_ANSWER_MODEL ?? "").trim();
  const chosenModels = configuredModel ? [configuredModel, ...DEFAULT_ANSWER_MODELS.filter((model) => model !== configuredModel)] : DEFAULT_ANSWER_MODELS;

  try {
    const hf = ensureHfConfigured();
    const modelAnswer = await tryGenerateModelAnswer(
      hf,
      `Eres Justino, un asistente institucional de SENASICA. Responde con una respuesta breve, clara y útil. Usa únicamente la información del contexto y no inventes datos. Si no está en el contexto, dilo de forma honesta.\n\nContexto:\n${context}\n\nPregunta: ${cleanedQuery}`,
      chosenModels,
    );

    if (modelAnswer) {
      return buildHybridAnswer(matches, modelAnswer);
    }
  } catch (error) {
    console.error("HF generation failed:", error);
  }

  return buildHybridAnswer(matches);
}
