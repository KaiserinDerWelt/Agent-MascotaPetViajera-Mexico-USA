// Spanish keyword helpers for retrieval (Step 4 of docs/rag-improvement-plan.md).
// The embedding model (all-minilm) is weak in Spanish, so keywords back it up:
//   - keywordTokens(): stopwords out, light stemming ("desparasitado" ≈ "desparasitados")
//   - expandQuery(): words people use → words the SENASICA documents use ("comida" → "alimento")
//   - keywordQuery(): the same, as a websearch_to_tsquery string for Postgres full-text search
//   - isDirectoryChunk()/wantsDirectory(): keep the vet directory out unless the question is about vets
//
// GLOSSARY rule: add an entry only for a real wording gap seen in user questions or the tuning
// questions, never for an eval question with "set": "holdout".

const STOPWORDS = new Set(
  (
    "a al algo algun alguna como con cual cuales cuando cuanto cuantos de del donde el ella en entre es esa ese esta este " +
    "estar estoy ser ha hay la las le les lo los mas me mi mis muy no nos o para pero por porque puede puedo que se si sin sobre " +
    "son su sus te tengo tiene tu tus un una uno unos y ya yo debe deben debo hacer hago necesito quiero voy vengo llevo " +
    // Generic to every document: they only add noise to keyword matching.
    "perro perros perrito mascota mascotas viajar viaje viajo mexico"
  ).split(" "),
);

/** Wording gaps: user word (accent-free, lowercase) → document words. */
const GLOSSARY: Array<[RegExp, string]> = [
  [/\b(comida|comer|croquetas?)\b/, "alimento"],
  [/\b(renuevo|renueva|renovar|renovarlo)\b/, "renovación"],
  [/\b(dura|durar|duracion)\b/, "vigencia"],
  [/\b(europa|asia|africa|oceania|sudamerica|centroamerica|extranjero)\b/, "otro país exportación"],
];

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ");
}

const SUFFIXES = ["aciones", "acion", "iciones", "icion", "amientos", "amiento", "mente", "ados", "adas", "idos", "idas", "ado", "ada", "ido", "ida", "ar", "er", "ir", "es", "s", "a", "o", "e"];

/** Light Spanish stemmer: enough for plurals, gender and -ación/-ado families. */
export function stem(token: string): string {
  for (const suffix of SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) return token.slice(0, -suffix.length);
  }
  return token;
}

export function expandQuery(query: string): string {
  const normalized = normalizeText(query);
  const additions = GLOSSARY.filter(([pattern]) => pattern.test(normalized)).map(([, words]) => words);
  return additions.length ? `${query} ${additions.join(" ")}` : query;
}

export function keywordTokens(text: string): string[] {
  return normalizeText(text)
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token))
    .map(stem);
}

/** websearch_to_tsquery input: any keyword may match ("a or b or c"); Postgres does the Spanish stemming. */
export function keywordQuery(query: string): string {
  // Accents are kept: Postgres' Spanish stemmer expects real Spanish ("vacunación").
  const words = expandQuery(query)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(normalizeText(token).trim()));
  return [...new Set(words)].join(" or ");
}

/** A chunk of SENASICA's MVRA vet directory: names, municipalities, emails, phone numbers. */
export function isDirectoryChunk(content: string): boolean {
  if (/DIRECTORIO DE MVRA|ESTADO\s+MUNICIPIO\s+NOMBRE/i.test(content)) return true;
  const emails = (content.match(/@[a-z0-9-]+(\s*\.\s*[a-z]{2,})+/gi) ?? []).length;
  const words = content.split(/\s+/).filter((word) => /\p{L}{3,}/u.test(word));
  const upper = words.filter((word) => word === word.toUpperCase()).length;
  return emails >= 1 && words.length > 0 && upper / words.length > 0.35;
}

export function wantsDirectory(query: string): boolean {
  return /veterinari|mvra|directorio|clinica|hospital|quien (puede|me) (expedir|firmar|emitir|hacer)/.test(normalizeText(query));
}
