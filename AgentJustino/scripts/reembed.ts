// Re-embeds every row of public.documents IN PLACE (update, never delete). Safe to re-run.
// Needs SUPABASE_SERVICE_ROLE_KEY in .env: the anon key has no UPDATE policy (by design).
// Back up first: Supabase dashboard -> Table editor -> documents -> Export CSV.
// Run: npm run reembed -- --yes
import { createClient } from "@supabase/supabase-js";
import { generateEmbedding } from "../lib/embeddings.ts";
import { resolveEmbedModel } from "../lib/ollama.ts";

const PAGE_SIZE = 500;

async function main() {
  if (!process.argv.includes("--yes")) {
    console.error("Esto sobrescribe todos los embeddings. Haz un respaldo y vuelve a correr con --yes.");
    process.exit(1);
  }

  const url = (process.env.VITE_SUPABASE_URL ?? "").trim();
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!url || !serviceKey) {
    console.error("Faltan VITE_SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en .env.");
    process.exit(1);
  }

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
  console.log(`Re-embebiendo con ${resolveEmbedModel()}…`);

  let updated = 0;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("documents")
      .select("id, content")
      .order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data?.length) break;

    for (const row of data) {
      const embedding = await generateEmbedding(String(row.content ?? ""));
      const { data: changed, error: updateError } = await supabase
        .from("documents")
        .update({ embedding })
        .eq("id", row.id)
        .select("id");
      if (updateError) throw updateError;
      if (!changed?.length) throw new Error(`No se actualizó la fila ${row.id} (¿permisos?)`);
      updated++;
      if (updated % 25 === 0) console.log(`  ${updated} filas…`);
    }

    if (data.length < PAGE_SIZE) break;
  }

  console.log(`✅ ${updated} filas re-embebidas.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
