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
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const query = typeof req.body?.query === "string" ? req.body.query : "";

  // 1. Crear embedding de la consulta
  const embedding = await openai.embeddings.create({
    model: "text-embedding-ada-002",
    input: query,
  });

  // 2. Buscar documentos similares en Supabase
  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding: embedding.data[0].embedding,
    match_count: 3,
  });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const context = (data ?? []).map((d: { content: string }) => d.content).join("\n");

  // 3. Generar respuesta con contexto
  const completion = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      { role: "system", content: "Responde en tono institucional SENASICA." },
      { role: "user", content: `Pregunta: ${query}\nContexto:\n${context}` },
    ],
  });

  res.status(200).json({ answer: completion.choices[0].message.content });
}
