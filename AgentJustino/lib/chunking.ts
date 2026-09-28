export function splitTextIntoChunks(text: string, maxChunkLength = 800, overlap = 120): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return [];
  }

  const words = normalized.split(" ");
  const chunks: string[] = [];
  let currentWords: string[] = [];

  for (const word of words) {
    const candidate = currentWords.length > 0 ? `${currentWords.join(" ")} ${word}` : word;

    if (currentWords.length > 0 && candidate.length > maxChunkLength) {
      const chunk = currentWords.join(" ").trim();
      if (chunk) {
        chunks.push(chunk);
      }

      const overlapWords = Math.max(1, Math.min(currentWords.length, Math.ceil(overlap / 5)));
      currentWords = currentWords.slice(-overlapWords);
    }

    currentWords.push(word);
  }

  const finalChunk = currentWords.join(" ").trim();
  if (finalChunk) {
    chunks.push(finalChunk);
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

export function splitDocumentsIntoChunks(docs: string[], maxChunkLength = 800, overlap = 120): string[] {
  return docs
    .flatMap((doc) => splitTextIntoChunks(doc, maxChunkLength, overlap))
    .filter((chunk) => chunk.trim().length > 0);
}
