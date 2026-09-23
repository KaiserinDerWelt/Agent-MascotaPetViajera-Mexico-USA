// Creation of serverless functions for the API endpoints of the chat application
import { supabase } from "../lib/supabase";
import { HfInference } from "@huggingface/inference";

type ApiRequest = {
  body?: {
    query?: string;
  };
};

type ApiResponse = {
  status: (code: number) => {
    json: (payload: unknown) => void;
  };
};

const hf = new HfInference(process.env.HF_API_KEY!);

export default async function handler(req: ApiRequest, res: ApiResponse) {
  const query = typeof req.body?.query === "string" ? req.body.query : "";

  try {
    // 1. Embedding de la consulta
    const embedding = await hf.featureExtraction({
      model: "sentence-transformers/all-MiniLM-L6-v2",
      inputs: query,
    });

    // 2. Buscar documentos similares
    const { data, error } = await supabase.rpc("match_documents", {
      query_embedding: embedding[0],
      match_count: 3,
    });
    if (error) throw error;

    // 3. Concatenar contexto
    const context = (data as { content: string }[] ?? [])
      .map((d) => d.content)
      .join("\n");

    // 4. Generar respuesta
    const completion = await hf.textGeneration({
      model: "tiiuae/falcon-7b-instruct",
      inputs: `Pregunta: ${query}\nContexto:\n${context}\nResponde en tono institucional SENASICA.`,
      parameters: { max_new_tokens: 200 },
    });

    res.status(200).json({ answer: completion.generated_text });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    res.status(500).json({ error: message });
  }
}
