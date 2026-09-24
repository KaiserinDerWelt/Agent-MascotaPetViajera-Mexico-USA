import { generateEmbedding } from "./embeddings";
import { supabase } from "./supabase";
import { hf } from "./huggingface";

export async function answerQueryFromDocuments(query: string): Promise<string> {
  const cleanedQuery = query.trim();

  if (!cleanedQuery) {
    throw new Error("La pregunta está vacía");
  }

  const embedding = await generateEmbedding(cleanedQuery);

  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding: embedding,
    match_count: 3,
  });

  if (error) {
    throw new Error(`No pude consultar los documentos: ${error.message}`);
  }

  const matches = (data ?? []) as Array<{ content: string }>;

  if (!matches.length) {
    return "No encontré información relevante en los documentos cargados para responder tu pregunta.";
  }

  const context = matches.map((entry) => entry.content).join("\n\n");

  try {
    const completion = await hf.textGeneration({
      model: "tiiuae/falcon-7b-instruct",
      inputs: `Pregunta: ${cleanedQuery}\n\nContexto:\n${context}\n\nResponde como un asistente institucional de SENASICA, usando solo la información del contexto y responde de forma clara y breve.`,
      parameters: { max_new_tokens: 220 },
    });

    const answer = typeof completion?.generated_text === "string"
      ? completion.generated_text.trim()
      : "";

    if (answer) {
      return answer;
    }
  } catch {
    // ignore and fallback to document-based summary below
  }

  return matches
    .slice(0, 2)
    .map((match) => match.content.replace(/\s+/g, " ").trim())
    .join(" ")
    .slice(0, 800);
}
