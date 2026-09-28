function normalizeChunkText(value: string): string {
  return value
    .replace(/Hoja\s+\d+\s+de\s+\d+/gi, " ")
    .replace(/Direcci[oó]n General de Salud Animal/gi, " ")
    .replace(/Publicaciones Recientes/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,;:.!?])/g, "$1")
    .replace(/([,;:.!?])(?=\S)/g, "$1 ")
    .trim();
}

export function splitTextIntoChunks(text: string, maxChunkLength = 600, overlap = 80): string[] {
  const normalized = normalizeChunkText(text);

  if (!normalized) {
    return [];
  }

  const segments = normalized
    .split(/(?<=[.!?])\s+|\s{2,}/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (!segments.length) {
    return [];
  }

  const chunks: string[] = [];
  let current = "";

  for (const segment of segments) {
    const candidate = current ? `${current} ${segment}` : segment;

    if (candidate.length <= maxChunkLength) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current.trim());
      current = "";
    }

    if (segment.length > maxChunkLength) {
      const parts = segment.match(new RegExp(`.{1,${maxChunkLength}}`, "g")) ?? [segment];
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed) {
          chunks.push(trimmed);
        }
      }
      continue;
    }

    current = segment;
  }

  if (current) {
    chunks.push(current.trim());
  }

  return [...new Set(chunks.map((chunk) => chunk.replace(/\s+/g, " ").trim()).filter((chunk) => chunk.length >= 120))];
}

export function splitDocumentsIntoChunks(docs: string[], maxChunkLength = 600, overlap = 80): string[] {
  const allChunks = docs
    .flatMap((doc) => splitTextIntoChunks(doc, maxChunkLength, overlap))
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  return [...new Set(allChunks)];
}
