import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { HfInference } from "@huggingface/inference";
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

function normalizeEmbedding(value: unknown): number[] {
  if (Array.isArray(value)) {
    if (Array.isArray(value[0])) {
      return value[0] as number[];
    }
    if (value.every((item) => typeof item === "number")) {
      return value as number[];
    }
  }

  throw new Error("Embedding inválido");
}

async function main() {
  const env = readEnv();
  const supabase = createClient(env.VITE_SUPABASE_URL!, env.VITE_SUPABASE_ANON_KEY!);
  const hf = new HfInference(env.VITE_HF_API_KEY!);

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

  const chunks = [...new Set(docs.flatMap((doc) => splitDocumentsIntoChunks([doc], 600, 80)))];
  console.log(`Documentos originales: ${docs.length}`);
  console.log(`Chunks generados: ${chunks.length}`);

  const { error: deleteError } = await supabase.from("documents").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  if (deleteError) throw deleteError;

  for (const chunk of chunks) {
    const embedding = await hf.featureExtraction({
      model: "sentence-transformers/all-MiniLM-L6-v2",
      inputs: chunk,
    });

    const vector = normalizeEmbedding(embedding);

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
