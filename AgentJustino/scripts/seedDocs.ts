// Script para cargar FAQs en Supabase con pgvector
import { supabase } from "../lib/supabase"; // tu cliente Supabase
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Lista de documentos iniciales (ejemplo FAQs)
const docs = [
  "¿Cuáles son los requisitos para viajar con mascotas a EE.UU.?",
  "El SENASICA regula la entrada de animales a México.",
  "Los certificados de salud deben estar emitidos por un veterinario autorizado.",
];

async function seedDocs() {
  try {
    // Generar embeddings
    const embeddings = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: docs,
    });

    // Insertar en Supabase
    for (let i = 0; i < docs.length; i++) {
      await supabase.from("documents").insert({
        content: docs[i],
        embedding: embeddings.data[i].embedding,
      });
    }

    console.log("✅ FAQs cargadas correctamente en Supabase.");
  } catch (error) {
    console.error("❌ Error al cargar FAQs:", error);
  }
}

seedDocs();
