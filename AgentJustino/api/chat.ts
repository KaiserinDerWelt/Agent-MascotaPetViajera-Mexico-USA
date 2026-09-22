// Creation of serverless functions for the API endpoints of the chat application
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { query } = req.body;

  // Aquí luego conectaremos RAG + LoRA
  res.status(200).json({ answer: `Respuesta simulada para: ${query}` });
}
