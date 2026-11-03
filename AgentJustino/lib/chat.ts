import { generateEmbedding } from "./embeddings";
import { splitTextIntoChunks } from "./chunking";
import { ensureSupabaseConfigured } from "./supabase";
import { ensureHfConfigured } from "./huggingface";
import { classifyQuery, scopeReply, SCOPE_REPLIES, type HistoryTurn, type ScopeDecision } from "./scope";
import { buildChatMessages, type ChatMessage } from "./prompt";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Base models used when no fine-tuned model is configured, or as a fallback after it. */
const DEFAULT_ANSWER_MODELS = [
  "Qwen/Qwen2.5-7B-Instruct",
  "meta-llama/Llama-3.1-8B-Instruct",
  "mistralai/Mistral-7B-Instruct-v0.2",
];

const MATCH_COUNT = 3;
const CONTEXT_CHUNKS = 4;
const MODEL_TIMEOUT_MS = 20000;

type EnvRecord = Record<string, string | undefined>;

function readEnv(name: string): string {
  const viteEnv: EnvRecord = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};
  const nodeEnv: EnvRecord = typeof process !== "undefined" ? process.env ?? {} : {};
  return (viteEnv[name] ?? nodeEnv[name] ?? "").trim();
}

type AnswerTarget = {
  label: string;
  model?: string;
  /** An @huggingface/inference provider id, e.g. "hf-inference", "featherless-ai", "auto". */
  provider?: string;
  endpointUrl?: string;
};

/** The part of the HF InferenceClient we use (src/global.d.ts declares the package untyped). */
type ChatCompletionClient = {
  chatCompletion: (args: Record<string, unknown>) => Promise<unknown>;
};

/**
 * Which models to ask, in order. Each target gets ONE call, so a question costs at most
 * VITE_HF_MAX_MODEL_CALLS (default 2) chat-completion calls.
 *
 * - VITE_HF_ENDPOINT_URL: dedicated Inference Endpoint (e.g. the LoRA fine-tuned Justino model).
 * - VITE_HF_ANSWER_MODEL: model id on the Hub (e.g. the merged LoRA model), tried first.
 * - VITE_HF_PROVIDER: inference provider for Hub models (default: HF "auto" routing).
 */
function getAnswerTargets(): AnswerTarget[] {
  const endpointUrl = readEnv("VITE_HF_ENDPOINT_URL");
  const configuredModel = readEnv("VITE_HF_ANSWER_MODEL");
  const provider = readEnv("VITE_HF_PROVIDER") || undefined;
  const maxCalls = Math.max(1, Number.parseInt(readEnv("VITE_HF_MAX_MODEL_CALLS"), 10) || 2);

  const targets: AnswerTarget[] = [];

  if (endpointUrl) {
    targets.push({ label: configuredModel || endpointUrl, endpointUrl, model: configuredModel || undefined });
  } else if (configuredModel) {
    targets.push({ label: configuredModel, model: configuredModel, provider });
  }

  for (const model of DEFAULT_ANSWER_MODELS) {
    if (model !== configuredModel) {
      targets.push({ label: model, model, provider });
    }
  }

  return targets.slice(0, maxCalls);
}

// ---------------------------------------------------------------------------
// Retrieval helpers
// ---------------------------------------------------------------------------

type RankableMatch = {
  id?: number | string;
  content: string;
};

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function scoreMatchRelevance(query: string, content: string): number {
  const queryTokens = tokenize(query);
  const contentTokens = tokenize(content);
  const contentSet = new Set(contentTokens);

  if (!queryTokens.length || !contentTokens.length) {
    return 0;
  }

  const overlap = queryTokens.filter((token) => contentSet.has(token)).length;
  const keywordRatio = overlap / Math.max(queryTokens.length, 1);
  const contentLengthBonus = Math.min(contentTokens.length / 120, 1.5);

  return keywordRatio * 10 + overlap + contentLengthBonus;
}

function rankMatches(query: string, matches: RankableMatch[]): RankableMatch[] {
  return [...matches].sort((a, b) => scoreMatchRelevance(query, b.content) - scoreMatchRelevance(query, a.content));
}

/** Removes SENASICA page headers/footers that add noise to retrieved text. */
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
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push({ ...match, content: normalized });
  }

  return output;
}

function expandMatchesIntoChunks(matches: RankableMatch[]): RankableMatch[] {
  const seen = new Set<string>();
  const expanded: RankableMatch[] = [];

  for (const match of matches) {
    const chunks = splitTextIntoChunks(match.content, 600, 80);
    for (const content of chunks.length ? chunks : [match.content]) {
      if (seen.has(content)) continue;
      seen.add(content);
      expanded.push({ id: match.id, content });
    }
  }

  return expanded;
}

function formatContext(matches: RankableMatch[]): string {
  return matches.map((match, index) => `[${index + 1}] ${match.content}`).join("\n\n");
}

// ---------------------------------------------------------------------------
// Answer composition
// ---------------------------------------------------------------------------

function normalizeGeneratedText(result: unknown): string {
  if (typeof result === "string") return result.trim();

  if (result && typeof result === "object") {
    const content = (result as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
    if (typeof content === "string") return content.trim();

    const generated = (result as { generated_text?: unknown }).generated_text;
    if (typeof generated === "string") return generated.trim();
  }

  return "";
}

/** Light cleanup that keeps line breaks, so lists of requirements still render as lists. */
function cleanModelAnswer(answer: string): string {
  return answer
    .replace(/^\s*(respuesta|answer|justino)\s*[:-]\s*/i, "")
    .replace(/\b(seg[uú]n|de acuerdo con|con base en)\s+(el|la)\s+(contexto|informaci[oó]n de referencia)\s*[,:]?\s*/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SCOPE_REPLY_SET = new Set<string>(Object.values(SCOPE_REPLIES));

/** Extractive answer used when no model is available: the most relevant sentences from the documents. */
function buildEvidenceAnswer(query: string, matches: RankableMatch[]): string {
  const queryTokens = new Set(tokenize(query));
  const seen = new Set<string>();

  const sentences = matches
    .flatMap((match) => match.content.split(/(?<=[.!?;])\s+/))
    .map((sentence) => sentence.replace(/https?:\/\/\S+/g, "").trim())
    .filter((sentence) => sentence.length >= 40 && sentence.length <= 400)
    .filter((sentence) => {
      const key = sentence.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((sentence) => ({
      sentence,
      score: tokenize(sentence).filter((token) => queryTokens.has(token)).length,
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => entry.sentence);

  if (!sentences.length) {
    return "Olfateé toda mi información de SENASICA y no encontré ese dato 🐾. Para no darte una pista equivocada, confírmalo directamente con SENASICA antes de viajar.";
  }

  return [
    "¡Guau! Esto es lo que encontré con mi olfato en la información de SENASICA 🐾:",
    ...sentences.map((sentence) => `• ${sentence}`),
    "",
    "Antes de viajar, confírmalo con SENASICA para que tu perrito llegue sin contratiempos.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

type FailureKind = "hf_credits" | "hf_auth" | "database" | "unknown";

function getStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { httpResponse?: { status?: unknown }; status?: unknown };
  const status = candidate.httpResponse?.status ?? candidate.status;
  return typeof status === "number" ? status : undefined;
}

function classifyFailure(error: unknown): FailureKind {
  const status = getStatus(error);
  const message = error instanceof Error ? error.message : String(error ?? "");

  if (status === 402 || /no remaining credits|pre-paid credits|payment required/i.test(message)) return "hf_credits";
  if (status === 401 || status === 403 || /hugging face|invalid (credentials|token)|unauthorized/i.test(message)) return "hf_auth";
  if (/supabase|fetch failed|failed to fetch|ENOTFOUND|network/i.test(message)) return "database";
  return "unknown";
}

const FAILURE_MESSAGES: Record<FailureKind, string> = {
  hf_credits:
    "¡Auu! 🐶 Ahorita no puedo responderte: el servicio de modelos de Hugging Face no tiene créditos disponibles. Intenta más tarde, aquí te espero.",
  hf_auth:
    "¡Auu! 🐶 Ahorita no puedo responderte: mi conexión con Hugging Face no está configurada correctamente.",
  database:
    "¡Auu! 🐶 No logré llegar a mi información de SENASICA. Intenta nuevamente en unos minutos, aquí te espero.",
  unknown:
    "¡Auu! 🐶 Algo falló de mi lado y no pude responderte. Intenta nuevamente en unos segundos.",
};

// ---------------------------------------------------------------------------
// Model call
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HF timeout for ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function generateModelAnswer(
  hf: ChatCompletionClient,
  messages: ChatMessage[],
): Promise<{ answer: string; model: string } | null> {
  for (const target of getAnswerTargets()) {
    try {
      const completion = await withTimeout(
        hf.chatCompletion({
          ...(target.endpointUrl ? { endpointUrl: target.endpointUrl } : {}),
          ...(target.model ? { model: target.model } : {}),
          ...(target.provider ? { provider: target.provider } : {}),
          messages,
          max_tokens: 320,
          temperature: 0.3,
          top_p: 0.9,
        }),
        MODEL_TIMEOUT_MS,
        target.label,
      );

      const answer = cleanModelAnswer(normalizeGeneratedText(completion));
      if (answer) return { answer, model: target.label };
    } catch (error) {
      const kind = classifyFailure(error);
      console.warn(`HF chatCompletion failed for ${target.label} (${kind}):`, error instanceof Error ? error.message : error);
      // No credits or bad token affect every model on this account: stop instead of burning more calls.
      if (kind === "hf_credits" || kind === "hf_auth") break;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type AnswerSource = "model" | "evidence" | "guardrail" | "error";

export type AnswerQueryResult = {
  answer: string;
  source: AnswerSource;
  usedModel: boolean;
  fallback: boolean;
  chunkIds: Array<number | string>;
  scope: ScopeDecision;
  model?: string;
};

/**
 * Answers a user question.
 * 1. Scope guard (no network): greetings and off-topic questions get a fixed reply.
 * 2. RAG: embed the question, retrieve SENASICA chunks from Supabase, re-rank.
 * 3. Model: Hugging Face chat completion with the shared prompt (fine-tuned model first if configured).
 * 4. If no model answers: extractive answer from the retrieved chunks.
 */
export async function answerQueryWithMetadata(query: string, history: HistoryTurn[] = []): Promise<AnswerQueryResult> {
  const cleanedQuery = query.trim();

  if (!cleanedQuery) {
    throw new Error("La pregunta está vacía");
  }

  const scope = classifyQuery(cleanedQuery, history);
  const guardrailReply = scopeReply(scope);

  if (guardrailReply) {
    return { answer: guardrailReply, source: "guardrail", usedModel: false, fallback: false, chunkIds: [], scope };
  }

  // For follow-ups ("¿y cuánto tarda?"), search with the previous question too.
  const previousUserQuestion = [...history].reverse().find((turn) => turn.role === "user")?.content ?? "";
  const retrievalQuery = scope.followUp && previousUserQuestion ? `${previousUserQuestion} ${cleanedQuery}` : cleanedQuery;

  try {
    const queryEmbedding = await generateEmbedding(retrievalQuery);
    const supabaseClient = ensureSupabaseConfigured();

    const { data, error } = await supabaseClient.rpc("match_documents", {
      query_embedding: queryEmbedding,
      match_count: MATCH_COUNT,
    });

    if (error) {
      console.warn("Supabase match_documents failed:", error);
      return { answer: FAILURE_MESSAGES.database, source: "error", usedModel: false, fallback: true, chunkIds: [], scope };
    }

    const matches = dedupeMatches((data ?? []) as RankableMatch[]);

    if (!matches.length) {
      return {
        answer: "Todavía no tengo información de SENASICA guardada para responder eso 🐾. Por ahora, consúltalo directamente con SENASICA.",
        source: "evidence",
        usedModel: false,
        fallback: true,
        chunkIds: [],
        scope,
      };
    }

    const rankedMatches = rankMatches(retrievalQuery, expandMatchesIntoChunks(matches)).slice(0, CONTEXT_CHUNKS);
    const chunkIds = rankedMatches.map((entry) => entry.id).filter((id): id is number | string => id !== undefined);
    const messages = buildChatMessages(formatContext(rankedMatches), cleanedQuery, history);

    let modelResult: { answer: string; model: string } | null = null;
    try {
      modelResult = await generateModelAnswer(ensureHfConfigured(), messages);
    } catch (modelError) {
      // Model errors are non-fatal: we still answer from the retrieved documents.
      console.warn("Answer model unavailable:", modelError);
    }

    if (modelResult) {
      const isRefusal = SCOPE_REPLY_SET.has(modelResult.answer);
      console.info("RAG answer with model", { query: cleanedQuery, model: modelResult.model, chunkIds });
      return {
        answer: modelResult.answer,
        source: isRefusal ? "guardrail" : "model",
        usedModel: true,
        fallback: false,
        chunkIds,
        scope: isRefusal ? { kind: "out_of_scope", reason: "off_topic" } : scope,
        model: modelResult.model,
      };
    }

    console.info("RAG answer fallback to evidence", { query: cleanedQuery, chunkIds });
    return {
      answer: buildEvidenceAnswer(retrievalQuery, rankedMatches),
      source: "evidence",
      usedModel: false,
      fallback: true,
      chunkIds,
      scope,
    };
  } catch (error) {
    const kind = classifyFailure(error);
    console.warn(`answerQueryWithMetadata failed (${kind}):`, error);
    return { answer: FAILURE_MESSAGES[kind], source: "error", usedModel: false, fallback: true, chunkIds: [], scope };
  }
}

export async function answerQueryFromDocuments(query: string, history: HistoryTurn[] = []): Promise<string> {
  const result = await answerQueryWithMetadata(query, history);
  return result.answer;
}
