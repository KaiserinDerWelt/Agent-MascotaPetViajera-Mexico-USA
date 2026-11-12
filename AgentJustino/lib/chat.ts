import { generateEmbedding } from "./embeddings.ts";
import { splitTextIntoChunks } from "./chunking.ts";
import { ensureSupabaseConfigured } from "./supabase.ts";
import { OllamaError, ollamaChat, readEnv } from "./ollama.ts";
import { classifyQuery, scopeReply, SCOPE_REPLIES, type HistoryTurn, type ScopeDecision } from "./scope.ts";
import { buildChatMessages, type ChatMessage } from "./prompt.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Answer model (Ollama Cloud) used when VITE_OLLAMA_CHAT_MODEL is not set. */
const DEFAULT_CHAT_MODEL = "glm-5.3-flash";
/** Fallback models used when VITE_OLLAMA_FALLBACK_MODELS is not set. */
const DEFAULT_FALLBACK_MODELS = ["gpt-oss:20b"];

const MATCH_COUNT = 3;
const CONTEXT_CHUNKS = 4;
/** Generous enough for a self-hosted CPU model too (cold loads are slow). */
const DEFAULT_MODEL_TIMEOUT_MS = 60000;
const NUM_CTX = 4096;

function readList(name: string): string[] | undefined {
  const raw = readEnv(name);
  if (!raw) return undefined;
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

/**
 * Ollama models to ask, in order. Each gets ONE call, so a question makes at most
 * VITE_LLM_MAX_MODEL_CALLS (default 2) chat calls.
 *
 * - VITE_OLLAMA_CHAT_MODEL: primary model. Default glm-5.3-flash (Ollama Cloud).
 * - VITE_OLLAMA_FALLBACK_MODELS: comma-separated fallbacks. Default gpt-oss:20b.
 */
export function getAnswerModels(): string[] {
  const primary = readEnv("VITE_OLLAMA_CHAT_MODEL") || DEFAULT_CHAT_MODEL;
  const fallbacks = readList("VITE_OLLAMA_FALLBACK_MODELS") ?? DEFAULT_FALLBACK_MODELS;
  const maxCalls = Math.max(1, Number.parseInt(readEnv("VITE_LLM_MAX_MODEL_CALLS"), 10) || 2);

  return [...new Set([primary, ...fallbacks])].slice(0, maxCalls);
}

function getModelTimeoutMs(): number {
  return Math.max(1000, Number.parseInt(readEnv("VITE_LLM_TIMEOUT_MS"), 10) || DEFAULT_MODEL_TIMEOUT_MS);
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

type FailureKind = "model_unreachable" | "model_missing" | "database" | "unknown";

export function classifyFailure(error: unknown): FailureKind {
  if (error instanceof OllamaError) {
    if (error.kind === "unreachable" || error.kind === "timeout") return "model_unreachable";
    if (error.kind === "model_missing") return "model_missing";
    return "unknown";
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/supabase|fetch failed|failed to fetch|ENOTFOUND|network/i.test(message)) return "database";
  return "unknown";
}

export const FAILURE_MESSAGES: Record<FailureKind, string> = {
  model_unreachable:
    "¡Auu! 🐶 Mi cerebro de perrito está tomando una siesta y no puedo responderte ahorita. Intenta en unos minutos, aquí te espero.",
  model_missing:
    "¡Auu! 🐶 Algo de mi configuración no está listo y no puedo responderte. Avísale a mi equipo, por favor.",
  database:
    "¡Auu! 🐶 No logré llegar a mi información de SENASICA. Intenta nuevamente en unos minutos, aquí te espero.",
  unknown:
    "¡Auu! 🐶 Algo falló de mi lado y no pude responderte. Intenta nuevamente en unos segundos.",
};

// ---------------------------------------------------------------------------
// Model call
// ---------------------------------------------------------------------------

async function generateModelAnswer(messages: ChatMessage[]): Promise<{ answer: string; model: string } | null> {
  const timeoutMs = getModelTimeoutMs();

  for (const model of getAnswerModels()) {
    try {
      const raw = await ollamaChat(messages, {
        model,
        maxTokens: 320,
        temperature: 0.3,
        topP: 0.9,
        numCtx: NUM_CTX,
        timeoutMs,
      });

      const answer = cleanModelAnswer(raw);
      if (answer) return { answer, model };
    } catch (error) {
      const kind = error instanceof OllamaError ? error.kind : "unknown";
      console.warn(`Ollama chat failed for ${model} (${kind}):`, error instanceof Error ? error.message : error);
      // These affect every model on the same server/account: don't burn more calls.
      if (kind === "unreachable" || kind === "auth" || kind === "credits" || kind === "rate_limited") break;
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
 * 3. Model: Ollama chat with the shared prompt (fine-tuned model first if configured).
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

    // Model errors are non-fatal: without a model we still answer from the retrieved documents.
    const modelResult = await generateModelAnswer(messages);

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
