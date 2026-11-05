// Read-only check: are the vectors stored in Supabase compatible with Ollama's embeddings?
// Re-embeds a sample of rows and prints the cosine similarity with the stored vector.
// Run: npm run check-embeddings [-- <sampleSize>]
import { ensureSupabaseConfigured } from "../lib/supabase.ts";
import { generateEmbedding } from "../lib/embeddings.ts";
import { resolveEmbedModel, resolveOllamaBaseUrl } from "../lib/ollama.ts";

const THRESHOLD = 0.99;

function parseVector(value: unknown): number[] {
  // pgvector comes back from PostgREST as a string like "[0.1,0.2,...]".
  if (typeof value === "string") return JSON.parse(value) as number[];
  if (Array.isArray(value)) return value as number[];
  throw new Error("Formato de embedding desconocido");
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function main() {
  const sampleSize = Number.parseInt(process.argv[2] ?? "20", 10) || 20;
  console.log(`Ollama: ${resolveOllamaBaseUrl()} · modelo: ${resolveEmbedModel()} · muestra: ${sampleSize}`);

  const { data, error } = await ensureSupabaseConfigured()
    .from("documents")
    .select("id, content, embedding")
    .limit(sampleSize);
  if (error) throw error;

  const rows = data ?? [];
  if (!rows.length) {
    console.log("No hay documentos en Supabase.");
    return;
  }

  const scores: number[] = [];
  for (const row of rows) {
    const stored = parseVector(row.embedding);
    const fresh = await generateEmbedding(String(row.content ?? ""));
    const score = cosine(stored, fresh);
    scores.push(score);
    console.log(`${score.toFixed(4)}  ${String(row.id).slice(0, 8)}  ${String(row.content).slice(0, 60).replace(/\s+/g, " ")}…`);
  }

  const min = Math.min(...scores);
  const avg = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  console.log(`\nmin ${min.toFixed(4)} · avg ${avg.toFixed(4)} · umbral ${THRESHOLD}`);

  if (min >= THRESHOLD) {
    console.log("✅ Compatible: los vectores guardados sirven con Ollama. No hace falta re-embeber.");
  } else {
    console.log("⚠️  No compatible: exporta la tabla documents y corre `npm run reembed -- --yes`.");
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
