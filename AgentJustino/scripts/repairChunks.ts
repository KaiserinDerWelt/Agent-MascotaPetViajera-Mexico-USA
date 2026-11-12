// WARNING: deletes EVERY row in public.documents before re-inserting the re-chunked text.
// If embedding fails halfway, data is lost. To only refresh vectors, use scripts/reembed.ts.
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { generateEmbedding } from "../lib/embeddings.ts";
import { splitDocumentsIntoChunks } from "../lib/chunking.ts";

function readEnv(filePath = ".env") {
  const content = fs.readFileSync(filePath, "utf8");
  return Object.fromEntries(
    content
      .split(/\r?\n/)
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

async function main() {
  const env = readEnv();
  const supabase = createClient(env.VITE_SUPABASE_URL!, env.VITE_SUPABASE_ANON_KEY!);
  // Lets lib/ollama.ts pick up OLLAMA_BASE_URL / VITE_OLLAMA_EMBED_MODEL from .env.
  for (const [key, value] of Object.entries(env)) process.env[key] ??= value;

  const { data: existingRows, error: fetchError } = await supabase
    .from("documents")
    .select("id, content")
    .limit(2000);

  if (fetchError) throw fetchError;

  const docs = (existingRows ?? []).map((row) => String(row.content ?? "")).filter(Boolean);
  if (!docs.length) {
    console.log("No hay documentos para reparar.");
    return;
  }

  const chunks = [...new Set(docs.flatMap((doc) => splitDocumentsIntoChunks([doc])))];
  console.log(`Documentos originales: ${docs.length}`);
  console.log(`Chunks generados: ${chunks.length}`);

  const { error: deleteError } = await supabase.from("documents").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  if (deleteError) throw deleteError;

  for (const chunk of chunks) {
    const vector = await generateEmbedding(chunk);

    const { error: insertError } = await supabase.from("documents").insert({
      content: chunk,
      embedding: vector,
    });

    if (insertError) {
      console.error("Error insertando chunk:", insertError.message);
      throw insertError;
    }
  }

  console.log("Base de Supabase reparada con chunks.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
