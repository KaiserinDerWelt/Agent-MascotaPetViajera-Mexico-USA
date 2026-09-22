// Creation of serverless functions for the API endpoints of the chat application
type NextApiRequest = {
  body?: {
    query?: string;
  };
};

type NextApiResponse<T = unknown> = {
  status: (code: number) => {
    json: (payload: T) => void;
  };
  json: (payload: T) => void;
};

import { supabase } from "../lib/supabase"; // tu cliente Supabase
import { HfInference } from "@huggingface/inference";

const hf = new HfInference(process.env.HF_API_KEY!);

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const query = typeof req.body?.query === "string" ? req.body.query : "";

  // 1. Crear embedding de la consulta con Hugging Face
  const embedding = await hf.featureExtraction({
    model: "sentence-transformers/all-MiniLM-L6-v2",
    inputs: query,
  });

  // 2. Buscar documentos similares en Supabase
  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding: embedding[0], // vector generado
    match_count: 3,
  });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const context = (data ?? []).map((d: { content: string }) => d.content).join("\n");

  // 3. Generar respuesta con contexto usando Hugging Face
  const completion = await hf.textGeneration({
    model: "tiiuae/falcon-7b-instruct",
    inputs: `Pregunta: ${query}\nContexto:\n${context}\nResponde en tono institucional SENASICA.`,
    parameters: { max_new_tokens: 200 },
  });

  res.status(200).json({ answer: completion.generated_text });
}
