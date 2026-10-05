import { generateEmbedding } from "./embeddings";
import { splitTextIntoChunks } from "./chunking";
import { ensureSupabaseConfigured } from "./supabase";
import { ensureHfConfigured } from "./huggingface";

const DEFAULT_ANSWER_MODELS = [
  "Qwen/Qwen2.5-7B-Instruct",
  "meta-llama/Llama-3.1-8B-Instruct",
  "mistralai/Mistral-7B-Instruct-v0.2",
  "microsoft/Phi-3-mini-4k-instruct",
  "Qwen/Qwen2.5-3B-Instruct",
];

function normalizeGeneratedText(result: unknown): string {
  if (typeof result === "string") {
    return result.trim();
  }

  if (Array.isArray(result) && result.length > 0 && typeof result[0] === "string") {
    return result[0].trim();
  }

  if (result && typeof result === "object") {
    const candidate =
      (result as { generated_text?: unknown; text?: unknown }).generated_text ??
      (result as { generated_text?: unknown; text?: unknown }).text ??
      (result as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;

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
    .replace(/^(según\s+el\s+contexto|based\s+on\s+the\s+context|segun\s+el\s+contexto)\s*[:\-]?\s*/i, "")
    .replace(/^(te\s+puedo\s+decir|te\s+diría|te\s+diria|pues|bueno|vale|listo)\s*[:\-]?\s*/i, "")
    .replace(/^justino\s*[:\-]?\s*/i, "")
    .replace(/\b(contexto|pregunta|informacion|información|documentos|fuente|fuentes)\s*[:\-]/gi, "")
    .replace(/\b(corrobora|corroborar|verificar|verificado)\b[^.]*[.]/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+[.]{2,}\s*$/g, "")
    .replace(/\s+([,;:.!?])\s*/g, "$1 ")
    .trim();
}

function buildMexicanSpanishPrompt(context: string, query: string): string {
  return [
    "Eres Justino, un asistente de SENASICA que responde en español de México.",
    "Tu objetivo es ayudar a personas que quieren viajar con mascotas entre México y Estados Unidos.",
    "Usa un tono cercano, claro, útil y profesional, como si hablaras con una persona real.",
    "Reglas estrictas:",
    "1) Usa solo la información del contexto proporcionado.",
    "2) Si la información no está en el contexto, dilo con honestidad y no inventes.",
    "3) No copies frases literales del documento ni menciones 'según el contexto'.",
    "4) Responde en 2 a 4 líneas máximo, con frases naturales y directas.",
    "5) Si se requieren requisitos, menciona solo los más relevantes y útiles.",
    "6) Si se comparan casos por país o tipo de viaje, explica la diferencia breve y clara.",
    "7) No respondas como un resumen largo de un PDF. Responde como un asistente útil.",
    "",
    `Contexto:\n${context}`,
    "",
    `Pregunta: ${query}`,
  ].join("\n");
}

function normalizeTextForScore(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function scoreMatchRelevance(query: string, content: string): number {
  const queryTokens = normalizeTextForScore(query);
  const contentTokens = normalizeTextForScore(content);
  const contentSet = new Set(contentTokens);

  if (!queryTokens.length || !contentTokens.length) {
    return 0;
  }

  const overlap = queryTokens.filter((token) => contentSet.has(token)).length;
  const keywordRatio = overlap / Math.max(queryTokens.length, 1);
  const contentLengthBonus = Math.min(contentTokens.length / 120, 1.5);

  return keywordRatio * 10 + overlap + contentLengthBonus;
}

type RankableMatch = {
  id?: number | string;
  content: string;
};

function rankMatches(query: string, matches: RankableMatch[]) {
  return [...matches].sort((a, b) => {
    const scoreA = scoreMatchRelevance(query, a.content);
    const scoreB = scoreMatchRelevance(query, b.content);
    return scoreB - scoreA;
  });
}

function expandMatchesIntoChunks(matches: RankableMatch[]): RankableMatch[] {
  const expanded: RankableMatch[] = [];

  for (const match of matches) {
    const content = normalizeMatchContent(match.content);
    if (!content) continue;

    const chunks = splitTextIntoChunks(content, 600, 80);
    if (chunks.length > 0) {
      expanded.push(...chunks.map((chunk) => ({ id: match.id, content: chunk })));
      continue;
    }

    expanded.push({ id: match.id, content });
  }

  return [...new Set(expanded.map((item) => `${item.id ?? "no-id"}:${item.content}`))]
    .map((entry) => {
      const [idPart, ...contentParts] = entry.split(":");
      const id = idPart === "no-id" ? undefined : idPart;
      return { id, content: contentParts.join(":") };
    });
}

function normalizeMatchContent(content: string): string {
  return content
    .replace(/Hoja\s+\d+\s+de\s+\d+.*$/gi, " ")
    .replace(/Direcci[oó]n General de Salud Animal.*$/gi, " ")
    .replace(/Publicaciones Recientes.*$/gi, " ")
    .replace(/Servicio Nacional de Sanidad, Inocuidad y Calidad Agroalimentaria.*$/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeMatches(matches: RankableMatch[]): RankableMatch[] {
  const seen = new Set<string>();
  const output: RankableMatch[] = [];

  for (const match of matches) {
    const normalized = normalizeMatchContent(match.content);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    output.push({ ...match, content: normalized });
  }

  return output;
}

function summarizeEvidence(matches: Array<{ content: string }>, maxLength = 220): string {
  const uniqueTexts = [...new Set(
    matches
      .map((match) => normalizeMatchContent(match.content))
      .filter((text) => text.length > 80),
  )];

  const summary = uniqueTexts
    .slice(0, 2)
    .map((text) => {
      const clipped = text.length > maxLength ? `${text.slice(0, maxLength).trim()}...` : text;
      return clipped.replace(/\s+([,.;:!?])/g, "$1");
    })
    .join(" ");

  return summary.length > maxLength ? `${summary.slice(0, maxLength).trim()}...` : summary;
}

function buildGroundedFallbackAnswer(matches: Array<{ content: string }>): string {
  const evidence = dedupeMatches(matches)
    .map((match) => normalizeMatchContent(match.content))
    .filter((text) => text.length > 80)
    .slice(0, 2)
    .join(" ");

  if (!evidence) {
    return "No encontré información relevante en los documentos cargados para responder tu pregunta.";
  }

  const normalized = evidence
    .replace(/https?:\/\/[^\s]+/g, "")
    .replace(/\b(Servicio Nacional de Sanidad, Inocuidad y Calidad Agroalimentaria|Gobierno|SENASICA)\b/gi, "SENASICA")
    .replace(/\s+/g, " ")
    .trim();

  const shortText = normalized.length > 260 ? `${normalized.slice(0, 260).trim()}...` : normalized;

  const sanitizedText = shortText
    .replace(/\b(\.\s*){2,}\b/g, ". ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();

  if (/vacuna|rabia|certificado|salud|veterinario/i.test(sanitizedText)) {
    return `En general, la información indica que para viajar con una mascota es clave revisar los requisitos sanitarios y documentales, como vacunas, certificados veterinarios y cumplimiento de la normativa vigente. Lo más relevante es: ${sanitizedText}`;
  }

  return `La información más relevante señala que ${sanitizedText}`;
}

function buildHybridAnswer(matches: Array<{ content: string }>, modelAnswer?: string): string {
  const cleanedAnswer = modelAnswer ? sanitizeModelAnswer(modelAnswer) : "";
  const evidence = summarizeEvidence(matches);

  if (cleanedAnswer) {
    const answerWithoutSource = cleanedAnswer
      .replace(/\s+(Se puede corroborar con los documentos|Puedes corroborarlo con los documentos|Esto se puede verificar en los documentos|La información se encuentra en los documentos)[^.]*(\.|$)/gi, "")
      .replace(/\s+\.+\s*$/g, "")
      .trim();

    if (answerWithoutSource) {
      return evidence ? `${answerWithoutSource}\n\nEn resumen: ${evidence}` : answerWithoutSource;
    }
  }

  if (evidence) {
    return buildGroundedFallbackAnswer(matches);
  }

  return "No encontré información relevante en los documentos cargados para responder tu pregunta.";
}

function getHfProviderCandidates(): string[] {
  const viteEnv = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};
  const nodeEnv = typeof process !== "undefined" ? process.env ?? {} : {};
  const configuredProvider = (viteEnv.VITE_HF_PROVIDER ?? nodeEnv.VITE_HF_PROVIDER ?? "").trim();

  const candidates = [configuredProvider, "hf-inference", "featherless-ai"].filter((provider): provider is string => Boolean(provider && provider.trim()));
  return [...new Set(candidates)];
}

async function tryGenerateModelAnswer(
  hf: { chatCompletion?: (params: any) => Promise<unknown> },
  prompt: string,
  chosenModels: string[],
): Promise<string> {
  const requestTimeoutMs = 15000;
  const providerCandidates = getHfProviderCandidates();

  for (const modelName of chosenModels) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (!hf.chatCompletion) {
          continue;
        }

        const provider = providerCandidates[attempt % providerCandidates.length] ?? "hf-inference";
        const request = () =>
          hf.chatCompletion({
            ...(provider ? { provider } : {}),
            model: modelName,
            messages: [
              {
                role: "system",
                content: "Eres Justino, un asistente de SENASICA que responde en español de México. Sé breve, claro y útil. No inventes. Usa solo la información disponible en el contexto. Si falta información, dilo con honestidad. Responde en máximo 4 líneas y en un tono natural, cercano y profesional.",
              },
              { role: "user", content: prompt },
            ],
            max_tokens: 180,
            temperature: 0.4,
            top_p: 0.9,
          });

        const completion = await Promise.race([
          request(),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`HF timeout for ${modelName}`)), requestTimeoutMs);
          }),
        ]);

        const answer = normalizeGeneratedText(completion);
        const cleanedAnswer = answer ? sanitizeModelAnswer(answer) : "";

        if (cleanedAnswer && cleanedAnswer.length > 0) {
          return cleanedAnswer;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isProviderIssue = /(provider|unsupported|invalid|not available|bad request|403|429|network)/i.test(message);
        console.warn(`HF chatCompletion failed for ${modelName} (attempt ${attempt + 1}, provider: ${providerCandidates[attempt % providerCandidates.length] ?? "default"}):`, message);

        if (attempt === 0 && isProviderIssue) {
          continue;
        }

        if (attempt === 0) {
          continue;
        }
      }
    }
  }

  return "";
}

export type AnswerQueryResult = {
  answer: string;
  source: "model" | "evidence";
  usedModel: boolean;
  fallback: boolean;
  chunkIds: Array<number | string>;
};

export async function answerQueryWithMetadata(query: string): Promise<AnswerQueryResult> {
  const cleanedQuery = query.trim();

  if (!cleanedQuery) {
    throw new Error("La pregunta está vacía");
  }

  try {
    const embedding = await generateEmbedding(cleanedQuery);
    const supabaseClient = ensureSupabaseConfigured();

    const queryEmbedding = Array.isArray(embedding?.[0]) ? embedding[0] : embedding;

    const { data, error } = await supabaseClient.rpc("match_documents", {
      query_embedding: queryEmbedding,
      match_count: 3,
    });

    if (error) {
      console.warn("Supabase match_documents failed:", error);
      return {
        answer: "No pude consultar la base documental en este momento. Intenta nuevamente en unos segundos.",
        source: "evidence",
        usedModel: false,
        fallback: true,
        chunkIds: [],
      };
    }

    const rawMatches = (data ?? []) as RankableMatch[];
    const matches = dedupeMatches(rawMatches);

    if (!matches.length) {
      return {
        answer: "No encontré información relevante en los documentos cargados para responder tu pregunta.",
        source: "evidence",
        usedModel: false,
        fallback: true,
        chunkIds: [],
      };
    }

    const chunkedMatches = expandMatchesIntoChunks(matches);
    const rankedMatches = rankMatches(cleanedQuery, chunkedMatches).slice(0, 4);
    const context = rankedMatches.map((entry) => entry.content).join("\n\n");
    const topChunkIds = rankedMatches.map((entry) => entry.id).filter((id): id is number | string => id !== undefined);
    const viteEnv = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};
    const nodeEnv = typeof process !== "undefined" ? process.env ?? {} : {};
    const configuredModel = (viteEnv.VITE_HF_ANSWER_MODEL ?? nodeEnv.VITE_HF_ANSWER_MODEL ?? "").trim();
    const chosenModels = configuredModel ? [configuredModel, ...DEFAULT_ANSWER_MODELS.filter((model) => model !== configuredModel)] : DEFAULT_ANSWER_MODELS;

    try {
      const hf = ensureHfConfigured();
      const modelAnswer = await tryGenerateModelAnswer(
        hf,
        buildMexicanSpanishPrompt(context, cleanedQuery),
        chosenModels,
      );

      if (modelAnswer) {
        const finalAnswer = buildHybridAnswer(rankedMatches, modelAnswer);
        console.info("RAG answer with model", {
          query: cleanedQuery,
          chunkIds: topChunkIds,
          source: "model",
        });
        return {
          answer: finalAnswer,
          source: "model",
          usedModel: true,
          fallback: false,
          chunkIds: topChunkIds,
        };
      }
    } catch {
      // Provider errors are non-fatal: the app should keep responding with grounded RAG content.
    }

    const groundedAnswer = buildGroundedFallbackAnswer(rankedMatches);
    console.info("RAG answer fallback to evidence", {
      query: cleanedQuery,
      chunkIds: topChunkIds,
      source: "evidence",
    });

    return {
      answer: groundedAnswer,
      source: "evidence",
      usedModel: false,
      fallback: true,
      chunkIds: topChunkIds,
    };
  } catch (error) {
    console.warn("answerQueryWithMetadata failed; using safe fallback response:", error);

    return {
      answer: "No pude responder en este momento porque la conexión con la base documental o el modelo no está disponible. Intenta nuevamente en unos segundos.",
      source: "evidence",
      usedModel: false,
      fallback: true,
      chunkIds: [],
    };
  }
}

export async function answerQueryFromDocuments(query: string): Promise<string> {
  const result = await answerQueryWithMetadata(query);
  return result.answer;
}
