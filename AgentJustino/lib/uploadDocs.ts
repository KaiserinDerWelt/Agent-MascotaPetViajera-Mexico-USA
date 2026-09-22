import { supabase } from "./supabase";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function uploadDocs(docs: string[]) {
  const embeddings = await openai.embeddings.create({
    model: "text-embedding-ada-002",
    input: docs,
  });

  for (let i = 0; i < docs.length; i++) {
    await supabase.from("documents").insert({
      content: docs[i],
      embedding: embeddings.data[i].embedding,
    });
  }
}
