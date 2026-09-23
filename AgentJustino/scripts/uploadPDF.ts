import { readPDF } from "../lib/pdf";
import { generateEmbedding } from "../lib/embeddings";
import { supabase } from "../lib/supabase";

async function processPDF(file: File) {
  const text = await readPDF(file);
  const embedding = await generateEmbedding(text);

  const { error } = await supabase.from("documents").insert({
    content: text,
    embedding,
  });

  if (error) throw error;
  console.log("Documento guardado en Supabase ✅");
}

const file = new File(["dummy"], "manual.pdf", { type: "application/pdf" });
processPDF(file);
