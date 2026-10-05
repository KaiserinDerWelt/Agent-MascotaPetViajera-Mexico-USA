// Creation of serverless functions for the API endpoints of the chat application
import { ensureSupabaseConfigured } from "../lib/supabase";
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

export default async function handler(req: ApiRequest, res: ApiResponse) {
  const query = typeof req.body?.query === "string" ? req.body.query : "";

  try {
    const hfApiKey = (process.env.HF_API_KEY ?? process.env.VITE_HF_API_KEY ?? "").trim();
    if (!hfApiKey) {
      throw new Error("Falta la configuración de Hugging Face. Revisa HF_API_KEY o VITE_HF_API_KEY.");
    }

    const hf = new HfInference(hfApiKey);
    const supabaseClient = ensureSupabaseConfigured();

    // 1. Embedding de la consulta
    const embedding = await hf.featureExtraction({
      model: "sentence-transformers/all-MiniLM-L6-v2",
      inputs: query,
    });

    // 2. Buscar documentos similares
    const { data, error } = await supabaseClient.rpc("match_documents", {
      query_embedding: embedding[0],
      match_count: 3,
    });
    if (error) throw error;

    // 3. Concatenar contexto
    const context = (data as { content: string }[] ?? [])
      .map((d) => d.content)
      .join("\n");

    // 4. Generar respuesta con un prompt más natural y específico para español de México
    const completion = await hf.textGeneration({
      model: "microsoft/Phi-3.5-mini-instruct",
      inputs: [
        "Eres Justino, un asistente de SENASICA que responde en español de México.",
        "Usa un tono cercano, claro y útil. Responde solo con la información del contexto y no inventes.",
        "Si no hay suficiente información, dilo con honestidad. Máximo 4 líneas y sin repetir texto literal del documento.",
        "",
        `Contexto:\n${context}`,
        "",
        `Pregunta: ${query}`,
      ].join("\n"),
      parameters: {
        max_new_tokens: 180,
        temperature: 0.5,
        top_p: 0.9,
        do_sample: true,
        repetition_penalty: 1.08,
        return_full_text: false,
      },
    });

    const answer =
      typeof completion === "object" && completion && "generated_text" in completion && typeof completion.generated_text === "string"
        ? completion.generated_text
        : "";

    res.status(200).json({ answer });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    res.status(500).json({ error: message });
  }
}
