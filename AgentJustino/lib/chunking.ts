// Turns extracted PDF text into chunks for the vector store (Step 3 of docs/rag-improvement-plan.md).
//
// 1. prepareDocument(): removes the gob.mx page chrome (masthead, print headers, link targets,
//    share buttons, survey, legal disclaimer) and reads the page title, date and URL.
// 2. splitTextIntoChunks(): splits on sentences AND on the blank gaps that separate headings in
//    the PDF text, packs segments up to maxChunkLength, repeats the last ~overlap characters of
//    the previous chunk, and never leaves a heading orphaned at the end of a chunk.
// 3. buildChunks(): both of the above, with "[Title · SENASICA, date]" in front of every chunk, so
//    each chunk says what it is about even when its own text doesn't.

export const MAX_CHUNK_LENGTH = 900;
export const CHUNK_OVERLAP = 150;
/** Chunks with less real text than this (after removing page chrome) are not worth storing. */
export const MIN_USEFUL_CHARS = 80;

export type PreparedDocument = { title?: string; date?: string; url?: string; text: string };

const MONTH_DATE = String.raw`\d{1,2} de [a-záéíóú]+ de \d{4}`;

/** gob.mx page chrome. Order matters: the masthead and print headers go before the generic URL rules. */
const PAGE_CHROME: RegExp[] = [
  // Masthead: "Publicaciones Recientes (http://www.gob.mx) Servicio Nacional … | 04 de agosto de 2026 • (link) • (link)"
  new RegExp(String.raw`^\s*Publicaciones Recientes[\s\S]*?Agroalimentaria\s*\|\s*${MONTH_DATE}(\s*•?\s*\(https?:\/\/[^)\s]*\)?)*`, "i"),
  // Browser print header: "(?tab=) 􏊚 9/27/26, 7:08 PM Title | Servicio Nacional … | Gobierno… https://www.gob.mx/… 2/6"
  /(\(\?tab=\))?[^\p{L}\p{N}(]{0,12}\d{1,2}\/\d{1,2}\/\d{2},\s*\d{1,2}:\s?\d{2}\s*[AP]M\s+[^|]+\|[^|]+\|\s*Gobierno[^h]*https?:\/\/\S+\s+\d+\/\d+/giu,
  /Hoja\s+\d+\s+de\s+\d+/gi,
  /\(\s*https?:\/\/[^()]{0,300}?\)/gi, // "(https://bit.ly/…)", also links wrapped over lines
  /\(\s*https?:\/\/\S*/gi, // link cut off without its closing parenthesis
  /\(ht [^)]*\)/gi, // "(ht country-to-us-import/dogs)"
  /https?:\/\/\S+/gi,
  /\(\?tab=\)/gi,
  /Post\s+Compartir\s+\d+/gi,
  /Imprime la p[aá]gina completa/gi,
  /La legalidad, veracidad y la calidad de la informaci[oó]n[^.]*\./gi,
  /Contesta nuestra encuesta de satisfacci[oó]n\.?/gi,
  /¿C[oó]mo fue tu experiencia en gob\s*\.\s*mx\?/gi,
  /¡Senasica en la radio!/gi,
  /Galer[ií]a fotogr[aá]fica/gi,
  /Direcci[oó]n General de Salud Animal/gi,
  /Publicaciones Recientes/gi,
];

/** Removes page chrome but keeps the text, punctuation and the blank gaps between blocks. */
export function stripPageChrome(text: string): string {
  let output = text;
  for (const pattern of PAGE_CHROME) output = output.replace(pattern, "  ");
  return output.replace(/[^\S\n]*\n[^\S\n]*/g, "  ").replace(/ {3,}/g, "  ").trim();
}

/** Reads title/date/URL from a printed gob.mx page and returns its text without chrome. */
export function prepareDocument(raw: string): PreparedDocument {
  const title = raw.match(/\d{1,2}:\s?\d{2}\s*[AP]M\s+([^|]+?)\s*\|\s*Servicio Nacional/i)?.[1]?.trim();
  const date = raw.match(new RegExp(String.raw`Agroalimentaria\s*\|\s*(${MONTH_DATE})`, "i"))?.[1];
  // The page's own address is the one in the print header ("… | Gobierno | gob.mx  https://… 1/3").
  const url = raw.match(/Gobierno[^h]{0,20}(https?:\/\/www\.gob\.mx\/[^\s?]+)/i)?.[1];
  return { title, date, url, text: stripPageChrome(raw) };
}

/**
 * What is left of a chunk once the page chrome and all punctuation are removed.
 * Used to detect chunks that carry no real information.
 */
export function usefulText(content: string): string {
  return stripPageChrome(content)
    .replace(/\b(www|bit)\s*\.\s*\S+/gi, " ")
    .replace(/\d{1,2}\/\d{1,2}\/\d{2},\s*\d{1,2}\s*:\s*\d{2}\s*[AP]M[^]*?gob\s*\.\s*mx/gi, " ") // chunk-split print header
    .replace(/state=published\s*\d+\/\d+/gi, " ")
    .replace(/Servicio Nacional de Sanidad, Inocuidad y Calidad Agroalimentaria/gi, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tidy(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s+([,;:.!?)])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/([,;:!?])(?=\p{L})/gu, "$1 ") // "a,b" → "a, b"; leaves emails, URLs and phone numbers alone
    .replace(/\.(?=\p{Lu}\p{Ll})/gu, ". ") // "fin.Siguiente" → "fin. Siguiente"
    .trim();
}

/** A short line without final punctuation, e.g. "Origen EUA y procedencia EUA" or "Renovación". */
function looksLikeHeading(segment: string): boolean {
  return segment.length <= 70 && !/[.;:,]$/.test(segment) && /^\p{Lu}|^¿|^¡/u.test(segment);
}

function tail(segments: string[], maxLength: number): string[] {
  const output: string[] = [];
  let length = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    length += segments[i].length + 1;
    if (length > maxLength) break;
    output.unshift(segments[i]);
  }
  return output;
}

export function splitTextIntoChunks(text: string, maxChunkLength = MAX_CHUNK_LENGTH, overlap = CHUNK_OVERLAP): string[] {
  const segments = text
    .split(/(?<=[.!?])\s+|\s{2,}/) // sentence ends, and the blank gaps around headings and list items
    .map(tidy)
    .filter(Boolean)
    .flatMap((segment) => (segment.length > maxChunkLength ? (segment.match(new RegExp(`.{1,${maxChunkLength}}(\\s|$)`, "g")) ?? [segment]) : [segment]))
    .map((segment) => segment.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  let fresh = 0; // segments in `current` that are not overlap from the previous chunk

  const flush = () => {
    // Never end a chunk on a heading: it belongs to the text that follows.
    const carried: string[] = [];
    while (fresh - carried.length > 1 && looksLikeHeading(current[current.length - 1])) carried.unshift(current.pop()!);
    if (fresh - carried.length > 0) chunks.push(current.join(" "));
    current = [...tail(current, overlap), ...carried];
    length = current.reduce((sum, segment) => sum + segment.length + 1, 0);
    fresh = carried.length;
  };

  for (const segment of segments) {
    if (length + segment.length > maxChunkLength && fresh > 0) flush();
    current.push(segment);
    length += segment.length + 1;
    fresh++;
  }
  if (fresh > 0) chunks.push(current.join(" "));

  return [...new Set(chunks.filter((chunk) => usefulText(chunk).length >= MIN_USEFUL_CHARS))];
}

/** Full pipeline for one extracted document. `fallbackTitle` (e.g. the file name) is used when the page has none. */
export function buildChunks(raw: string, fallbackTitle?: string): string[] {
  const doc = prepareDocument(raw);
  const title = doc.title ?? fallbackTitle?.replace(/\.pdf$/i, "").trim();
  const label = title ? `[${[title, doc.date ? `SENASICA, ${doc.date}` : ""].filter(Boolean).join(" · ")}] ` : "";
  return splitTextIntoChunks(doc.text).map((chunk) => `${label}${chunk}`);
}

export function splitDocumentsIntoChunks(docs: string[], fallbackTitle?: string): string[] {
  return [...new Set(docs.flatMap((doc) => buildChunks(doc, fallbackTitle)))];
}
