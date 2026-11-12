import { generateEmbedding } from "./embeddings.ts";
import { MAX_CHUNK_LENGTH, splitTextIntoChunks, stripPageChrome } from "./chunking.ts";
import { ensureSupabaseConfigured } from "./supabase.ts";
import { OllamaError, ollamaChat, readEnv } from "./ollama.ts";
import { classifyQuery, scopeReply, SCOPE_REPLIES, type HistoryTurn, type ScopeDecision, type TravelDirection } from "./scope.ts";
import { buildChatMessages, type ChatMessage } from "./prompt.ts";
import { expandQuery, isDirectoryChunk, keywordQuery, keywordTokens, wantsDirectory } from "./searchTerms.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Answer model (Ollama Cloud) used when VITE_OLLAMA_CHAT_MODEL is not set. */
const DEFAULT_CHAT_MODEL = "glm-5.3-flash";
/** Fallback models used when VITE_OLLAMA_FALLBACK_MODELS is not set. */
const DEFAULT_FALLBACK_MODELS = ["gpt-oss:20b"];

/** Candidates from search; the best CONTEXT_CHUNKS of them reach the prompt (24% → 59% vs 3, eval/ 2026-11-12). */
const MATCH_COUNT = 10;
/** Vector-only fallback fetches more, because vet-directory rows are filtered out afterwards. */
const VECTOR_FETCH_COUNT = 30;
const CONTEXT_CHUNKS = 4;
/** Reciprocal-rank-fusion constant: smaller = the top ranks of each list weigh more. */
const RRF_K = 10;
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

export type RankableMatch = {
  id?: number | string;
  content: string;
};

/** Distinct query keywords (stemmed, stopwords out, glossary-expanded) found in the content. */
function keywordScore(queryKeys: Set<string>, content: string): number {
  const contentKeys = new Set(keywordTokens(content));
  let score = 0;
  for (const key of queryKeys) if (contentKeys.has(key)) score++;
  return score;
}

/**
 * Re-ranks search candidates by fusing their search order with a keyword order (reciprocal rank
 * fusion). Until 2026-11-12 the keyword score REPLACED the search order, which threw away correct
 * top results (e.g. "¿Qué debe incluir el certificado de buena salud?").
 */
function rankMatches(query: string, matches: RankableMatch[]): RankableMatch[] {
  const queryKeys = new Set(keywordTokens(expandQuery(query)));
  const byKeywords = matches
    .map((match, index) => ({ index, score: keywordScore(queryKeys, match.content) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const keywordRank = new Map(byKeywords.map((entry, rank) => [entry.index, rank]));

  return matches
    .map((match, index) => ({ match, fused: 1 / (RRF_K + index) + 1 / (RRF_K + keywordRank.get(index)!) }))
    .sort((a, b) => b.fused - a.fused)
    .map(({ match }) => match);
}

/**
 * Removes SENASICA page headers/footers that add noise to retrieved text.
 * (Until 2026-11-12 this used `.*$` patterns that deleted everything after "Servicio Nacional…" or
 * "Publicaciones Recientes", i.e. the requirement text that followed a page header.)
 */
function normalizeMatchContent(content: string): string {
  return stripPageChrome(content).replace(/\s+/g, " ").trim();
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
    // Only legacy rows stored before chunking are split here; normal chunks are used as stored.
    const chunks = match.content.length > MAX_CHUNK_LENGTH * 1.5 ? splitTextIntoChunks(match.content) : [];
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

/** "[Title · SENASICA, date] text" → label and text (labels are added by lib/chunking.ts). */
const CHUNK_LABEL = /^\[([^\]]+)\]\s*/;

/**
 * Canonical questions for an answer like "de México a Estados Unidos" to Justino's greeting.
 * Written in SENASICA's own wording, so search finds the page for that direction.
 */
const DIRECTION_QUESTIONS: Record<TravelDirection, string> = {
  mx_to_us:
    "Si viajas a Estados Unidos de América con tu perro: ¿necesito Certificado Zoosanitario para Exportación? certificado de salud, vigencia, Médico Veterinario Responsable Autorizado (MVRA), requisitos del CDC contra la rabia canina",
  us_to_mx:
    "Requisitos para ingresar a México con tu perro desde Estados Unidos (origen EUA): Certificado Zoosanitario para Importación (CZI), documento de inspección de gusano barrenador (GBG), inspección física",
};

/** Page titles about each direction: a direction answer only quotes those pages when any was retrieved. */
const DIRECTION_PAGES: Record<TravelDirection, RegExp> = {
  mx_to_us: /\b(a )?estados unidos\b|\bEUA\b/i,
  us_to_mx: /\ba méxico\b/i,
};
/** Long enough for SENASICA's run-on sentences (the key Mexico → US rule is ~480 characters). */
const MAX_EVIDENCE_SENTENCE = 600;

const DIRECTION_INTROS: Record<TravelDirection, string> = {
  mx_to_us: "¡Guau! Para viajar con tu perrito de México a Estados Unidos, esto dice SENASICA 🐾:",
  us_to_mx: "¡Guau! Para entrar con tu perrito a México desde Estados Unidos, esto dice SENASICA 🐾:",
};

/** PDF text loses line breaks: "…de servicio El certificado tendrá…". Split long run-ons before a sentence starter. */
function splitRunOn(sentence: string): string[] {
  if (sentence.length <= 300) return [sentence];
  return sentence
    .split(/(?<=[\p{Ll})])\s+(?=(?:El|La|Los|Las|Si|Para|Además|Derivado|Este|Esta|Recuerda|Cuando|También|No es|Tu)\s)/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Extractive answer used when no model is available: the sentences of the retrieved passages that
 * share the most keywords with the question (same Spanish matching as search: stemming + glossary).
 */
function buildEvidenceAnswer(query: string, matches: RankableMatch[], direction?: TravelDirection): string {
  const queryKeys = new Set(keywordTokens(expandQuery(query)));
  const seen = new Set<string>();

  // A direction answer must not quote rules for the opposite direction.
  const directionPages = direction ? matches.filter((match) => DIRECTION_PAGES[direction].test(match.content.match(CHUNK_LABEL)?.[1] ?? "")) : [];
  const sourceMatches = directionPages.length ? directionPages : matches;

  const chosen = sourceMatches
    .flatMap((match, matchIndex) => {
      const label = match.content.match(CHUNK_LABEL)?.[1];
      return match.content
        .replace(CHUNK_LABEL, "")
        .split(/(?<=[.!?;])\s+/)
        .flatMap(splitRunOn)
        .map((sentence, sentenceIndex) => ({ sentence: sentence.replace(/https?:\/\/\S+/g, "").trim(), label, order: matchIndex * 100 + sentenceIndex }));
    })
    .filter(({ sentence }) => sentence.length >= 40 && sentence.length <= MAX_EVIDENCE_SENTENCE)
    .filter(({ sentence }) => {
      const key = sentence.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((entry) => {
      const sentenceKeys = new Set(keywordTokens(entry.sentence));
      let score = 0;
      for (const key of queryKeys) if (sentenceKeys.has(key)) score++;
      return { ...entry, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, 3);

  if (!chosen.length) {
    return "Olfateé toda mi información de SENASICA y no encontré ese dato 🐾. Para no darte una pista equivocada, confírmalo directamente con SENASICA antes de viajar.";
  }

  const sources = [...new Set(chosen.map((entry) => entry.label).filter(Boolean))];

  return [
    direction ? DIRECTION_INTROS[direction] : "¡Guau! Esto es lo que encontré con mi olfato en la información de SENASICA 🐾:",
    ...chosen.map((entry) => `• ${entry.sentence}`),
    "",
    ...(sources.length ? [`Fuente: ${sources.join("; ")}`, ""] : []),
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
export type RetrievalResult =
  | { ok: true; matches: RankableMatch[]; rankedMatches: RankableMatch[] }
  | { ok: false; error: unknown };

/** PostgREST error code for "function not found": the hybrid search SQL has not been run yet. */
const FUNCTION_NOT_FOUND = "PGRST202";

/**
 * The retrieval half of the RAG pipeline: embed the query, search, then re-rank.
 * Uses hybrid search (vector + Spanish full-text, supabase/schema.sql step 7) when it exists,
 * otherwise vector search with the vet directory filtered out here.
 * Exported so scripts/evalRetrieval.ts measures exactly what the app does.
 */
export async function retrieveContext(retrievalQuery: string, matchCount = MATCH_COUNT): Promise<RetrievalResult> {
  const queryEmbedding = await generateEmbedding(retrievalQuery);
  const supabaseClient = ensureSupabaseConfigured();
  const includeDirectory = wantsDirectory(retrievalQuery);

  const hybrid = await supabaseClient.rpc("match_documents_hybrid", {
    query_text: keywordQuery(retrievalQuery),
    query_embedding: queryEmbedding,
    match_count: matchCount,
    include_directory: includeDirectory,
  });
  if (!hybrid.error) return { ok: true, ...rankContext(retrievalQuery, (hybrid.data ?? []) as RankableMatch[]) };
  if (hybrid.error.code !== FUNCTION_NOT_FOUND) return { ok: false, error: hybrid.error };

  const { data, error } = await supabaseClient.rpc("match_documents", {
    query_embedding: queryEmbedding,
    match_count: VECTOR_FETCH_COUNT,
  });
  if (error) return { ok: false, error };

  const hits = ((data ?? []) as RankableMatch[]).filter((hit) => includeDirectory || !isDirectoryChunk(hit.content));
  return { ok: true, ...rankContext(retrievalQuery, hits.slice(0, matchCount)) };
}

/** Vector-search hits (best first) → the CONTEXT_CHUNKS passages Justino reads. Pure; used by evals too. */
export function rankContext(retrievalQuery: string, hits: RankableMatch[]): { matches: RankableMatch[]; rankedMatches: RankableMatch[] } {
  const matches = dedupeMatches(hits);
  const rankedMatches = rankMatches(retrievalQuery, expandMatchesIntoChunks(matches)).slice(0, CONTEXT_CHUNKS);
  return { matches, rankedMatches };
}

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
  // "de México a Estados Unidos" (answering Justino's greeting) becomes a real question.
  const retrievalQuery =
    scope.followUp && scope.direction
      ? DIRECTION_QUESTIONS[scope.direction]
      : scope.followUp && previousUserQuestion
        ? `${previousUserQuestion} ${cleanedQuery}`
        : cleanedQuery;

  try {
    const retrieval = await retrieveContext(retrievalQuery);

    if (!retrieval.ok) {
      console.warn("Supabase match_documents failed:", retrieval.error);
      return { answer: FAILURE_MESSAGES.database, source: "error", usedModel: false, fallback: true, chunkIds: [], scope };
    }

    const { matches, rankedMatches } = retrieval;

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

    const chunkIds = rankedMatches.map((entry) => entry.id).filter((id): id is number | string => id !== undefined);
    const messages = buildChatMessages(formatContext(rankedMatches), scope.direction && scope.followUp ? retrievalQuery : cleanedQuery, history);

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
      answer: buildEvidenceAnswer(retrievalQuery, rankedMatches, scope.followUp ? scope.direction : undefined),
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
