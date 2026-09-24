// Script para cargar FAQs en Supabase con pgvector
import { supabase } from "../lib/supabase";
import { hf } from "../lib/huggingface";

async function seedDocs() {
  const text = "Este es un documento de prueba sobre transporte de perros en SENASICA.";

  // 1. Generar embedding con Hugging Face
  const embedding = await hf.featureExtraction({
    model: "sentence-transformers/all-MiniLM-L6-v2",
    inputs: text,
  });

  // 2. Insertar en Supabase
  const { error } = await supabase
    .from("documents")
    .insert({
      content: text,
      embedding: embedding[0],
    });

  if (error) {
    console.error("Error al insertar documento:", error.message);
  } else {
    console.log("Documento de prueba insertado correctamente ✅");
  }
}

seedDocs();

