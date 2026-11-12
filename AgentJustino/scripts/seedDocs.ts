// Inserts one test document. Run: npm run seed-docs
import { ensureSupabaseConfigured } from "../lib/supabase.ts";
import { generateEmbedding } from "../lib/embeddings.ts";

async function seedDocs() {
  const text = "Este es un documento de prueba sobre transporte de perros en SENASICA.";

  // 1. Embedding with Ollama
  const embedding = await generateEmbedding(text);

  // 2. Insert into Supabase
  const { error } = await ensureSupabaseConfigured().from("documents").insert({ content: text, embedding });

  if (error) {
    console.error("Error al insertar documento:", error.message);
    process.exitCode = 1;
  } else {
    console.log("Documento de prueba insertado correctamente ✅");
  }
}

seedDocs().catch((error) => {
  console.error(error);
  process.exit(1);
});
