// Read-only retrieval benchmark (Step 0 of docs/rag-improvement-plan.md).
// For every question in eval/retrieval-questions.json it checks whether the right passage is found:
//   - raw vector search (match_documents, top 10): hit@1, hit@3, hit@10, MRR
//   - the app's real context (retrieveContext in lib/chat.ts): what Justino actually gets to read
// A retrieved chunk is a hit when it contains any of the question's `expect` phrases.
// Needs: local Ollama with all-minilm:22m, VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.
// Run: npm run eval:retrieval [-- --verbose] [-- --out eval/results/baseline.json]
import fs from "node:fs";
import path from "node:path";
import { ensureSupabaseConfigured } from "../lib/supabase.ts";
import { generateEmbedding } from "../lib/embeddings.ts";
import { retrieveContext } from "../lib/chat.ts";
import { resolveEmbedModel } from "../lib/ollama.ts";

type Question = { id: string; lang: string; q: string; expect: string[]; set?: string };
type Row = { id: string; content: string; similarity: number };

const RAW_K = 10;
const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const outIndex = args.indexOf("--out");
const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isHit(content: string, expect: string[]): boolean {
  const haystack = normalize(content);
  return expect.some((phrase) => haystack.includes(normalize(phrase)));
}

async function fetchAllContent(): Promise<string[]> {
  const supabase = ensureSupabaseConfigured();
  const contents: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("documents").select("content").range(from, from + 999);
    if (error) throw error;
    contents.push(...(data ?? []).map((row) => String(row.content ?? "")));
    if (!data || data.length < 1000) break;
  }
  return contents;
}

function pct(n: number, total: number): string {
  return total ? `${((100 * n) / total).toFixed(0)}%`.padStart(4) : "  - ";
}

async function main() {
  const file = path.resolve(import.meta.dirname, "../eval/retrieval-questions.json");
  const { questions } = JSON.parse(fs.readFileSync(file, "utf8")) as { questions: Question[] };
  const supabase = ensureSupabaseConfigured();

  // Guard: a question whose answer is not stored anywhere can't be a retrieval failure.
  const corpus = await fetchAllContent();
  const answerable = questions.filter((question) => corpus.some((content) => isHit(content, question.expect)));
  const missing = questions.filter((question) => !answerable.includes(question));

  console.log(`Embeddings: ${resolveEmbedModel()} · filas en documents: ${corpus.length} · preguntas: ${questions.length}`);
  if (missing.length) {
    console.log(`⚠️  ${missing.length} pregunta(s) sin respuesta en la base (se excluyen): ${missing.map((m) => m.id).join(", ")}`);
  }

  const results = [];
  for (const question of answerable) {
    const embedding = await generateEmbedding(question.q);
    const { data, error } = await supabase.rpc("match_documents", { query_embedding: embedding, match_count: RAW_K });
    if (error) throw error;
    const rows = (data ?? []) as Row[];

    const rank = rows.findIndex((row) => isHit(row.content, question.expect)) + 1; // 0 = not found
    const uniqueTop3 = new Set(rows.slice(0, 3).map((row) => normalize(row.content))).size;

    const context = await retrieveContext(question.q);
    if (!context.ok) throw context.error;
    const contextHit = context.rankedMatches.some((match) => isHit(match.content, question.expect));

    results.push({ id: question.id, lang: question.lang, set: question.set ?? "tuning", rank, uniqueTop3, contextHit, topSimilarity: rows[0]?.similarity ?? 0 });

    if (verbose) {
      const mark = contextHit ? "✅" : rank ? "🟡" : "❌";
      console.log(`${mark} ${question.id.padEnd(20)} rank=${rank || "-"} únicos-top3=${uniqueTop3} sim=${(rows[0]?.similarity ?? 0).toFixed(3)}  ${question.q}`);
      if (!contextHit) console.log(`     top1: ${rows[0]?.content.slice(0, 110).replace(/\s+/g, " ")}…`);
    }
  }

  const summarize = (subset: typeof results) => {
    const n = subset.length;
    const at = (k: number) => subset.filter((r) => r.rank > 0 && r.rank <= k).length;
    const mrr = n ? subset.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / n : 0;
    return {
      n,
      hit1: at(1),
      hit3: at(3),
      hit10: at(RAW_K),
      mrr,
      context: subset.filter((r) => r.contextHit).length,
      uniqueTop3: n ? subset.reduce((sum, r) => sum + r.uniqueTop3, 0) / n : 0,
    };
  };

  console.log("\n            n   hit@1 hit@3 hit@10  MRR   contexto-app  únicos-en-top3");
  for (const [label, subset] of [
    ["todas", results],
    ["español", results.filter((r) => r.lang === "es")],
    ["inglés", results.filter((r) => r.lang === "en")],
    ["ajuste-es", results.filter((r) => r.lang === "es" && r.set === "tuning")],
    ["control-es", results.filter((r) => r.set === "holdout")],
  ] as const) {
    const s = summarize(subset);
    console.log(
      `${label.padEnd(10)} ${String(s.n).padStart(3)}   ${pct(s.hit1, s.n)}  ${pct(s.hit3, s.n)}  ${pct(s.hit10, s.n)}  ${s.mrr.toFixed(2)}      ${pct(s.context, s.n)}          ${s.uniqueTop3.toFixed(1)} / 3`,
    );
  }

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(
      outPath,
      JSON.stringify({ date: new Date().toISOString(), model: resolveEmbedModel(), rows: corpus.length, summary: summarize(results), results }, null, 2),
    );
    console.log(`\nResultados guardados en ${outPath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
