// Step 3 of docs/rag-improvement-plan.md: re-chunk the SENASICA pages with the new chunker.
//
//   npm run reingest-pages -- --backup backups/<file>.json
//
// Read-only. It:
//   1. takes the full page texts from a clean-docs backup (the rows stored before chunking),
//   2. builds new chunks with lib/chunking.ts and checks that no sentence of the page is lost,
//   3. finds the current rows that came from those pages (the vet directory is left alone),
//   4. compares current vs new chunks OFFLINE on eval/retrieval-questions.json, with the app's
//      own ranking (rankContext), and
//   5. writes backups/<…>.reingest.sql, which swaps the rows in one transaction.
import fs from "node:fs";
import path from "node:path";
import { ensureSupabaseConfigured } from "../lib/supabase.ts";
import { generateEmbedding } from "../lib/embeddings.ts";
import { buildChunks, prepareDocument, usefulText } from "../lib/chunking.ts";
import { rankContext, type RankableMatch } from "../lib/chat.ts";

type Row = { id: string; content: string; embedding: number[] };
type Question = { id: string; lang: string; q: string; expect: string[] };

const args = process.argv.slice(2);
const backupArg = args[args.indexOf("--backup") + 1];
const K = 10;

const normalize = (text: string) =>
  text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const isHit = (content: string, expect: string[]) => expect.some((phrase) => normalize(content).includes(normalize(phrase)));
const isDirectory = (content: string) => /DIRECTORIO DE MVRA|ESTADO\s+MUNICIPIO/i.test(content) || ((content.match(/@[a-z0-9.-]+\.\s?(com|mx)/gi) ?? []).length >= 2 && !/senasica\s*\.\s*gob/i.test(content));
const parseVector = (value: unknown) => (typeof value === "string" ? (JSON.parse(value) as number[]) : (value as number[]));
const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

/**
 * Share of the row's 6-word sequences that appear in the raw page: ~1 when the row was cut from it.
 * Compared on raw text because old chunks still contain the URLs and print headers.
 */
function containment(row: string, page: string): number {
  const words = normalize(row).split(" ");
  const pageText = ` ${normalize(page)} `;
  const shingles = words.length < 6 ? [words.join(" ")] : words.slice(0, -5).map((_, i) => words.slice(i, i + 6).join(" "));
  return shingles.filter((shingle) => pageText.includes(` ${shingle} `)).length / shingles.length;
}

async function fetchRows(): Promise<Row[]> {
  const supabase = ensureSupabaseConfigured();
  const { data, error } = await supabase.from("documents").select("id, content, embedding").range(0, 4999);
  if (error) throw error;
  return (data ?? []).map((row) => ({ id: row.id, content: row.content, embedding: parseVector(row.embedding) }));
}

function evaluate(corpus: Row[], questions: Question[], queryVectors: Map<string, number[]>) {
  let context = 0;
  let hit3 = 0;
  let hit10 = 0;
  const perQuestion: Record<string, boolean> = {};
  for (const question of questions) {
    const vector = queryVectors.get(question.id)!;
    const hits = corpus
      .map((row) => ({ row, score: cosine(vector, row.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, K)
      .map(({ row }): RankableMatch => ({ id: row.id, content: row.content }));
    const rank = hits.findIndex((hit) => isHit(hit.content, question.expect)) + 1;
    const inContext = rankContext(question.q, hits).rankedMatches.some((match) => isHit(match.content, question.expect));
    hit3 += +(rank > 0 && rank <= 3);
    hit10 += +(rank > 0);
    context += +inContext;
    perQuestion[question.id] = inContext;
  }
  return { context, hit3, hit10, perQuestion };
}

async function main() {
  if (!backupArg || backupArg.startsWith("--")) {
    console.error("Uso: npm run reingest-pages -- --backup backups/<archivo>.json");
    process.exit(1);
  }

  // 1–2. New chunks from the original pages.
  const backup = JSON.parse(fs.readFileSync(backupArg, "utf8")) as { content: string }[];
  const pages = backup.filter((row) => row.content.length > 1200 && prepareDocument(row.content).title);
  const newChunks: string[] = [];
  for (const page of pages) {
    const doc = prepareDocument(page.content);
    // --no-title: A/B check of the "[Title · SENASICA, date]" prefix.
    const chunks = buildChunks(page.content).map((chunk) => (args.includes("--no-title") ? chunk.replace(/^\[[^\]]*\]\s*/, "") : chunk));
    const joined = normalize(chunks.join(" "));
    const lost = doc.text
      .split(/(?<=[.!?])\s+|\s{2,}/)
      .filter((sentence) => usefulText(sentence).length >= 30 && !joined.includes(normalize(sentence)));
    console.log(`• ${doc.title} (${doc.date ?? "sin fecha"}): ${chunks.length} chunks${lost.length ? ` — ⚠️ ${lost.length} frase(s) perdida(s): ${lost.map((l) => l.slice(0, 60)).join(" | ")}` : ", ninguna frase perdida"}`);
    newChunks.push(...chunks);
  }

  // 3. Current rows that were cut from those pages.
  const rows = await fetchRows();
  const replace = rows.filter((row) => !isDirectory(row.content) && pages.some((page) => containment(row.content, page.content) >= 0.8));
  const keep = rows.filter((row) => !replace.includes(row));
  const orphans = keep.filter((row) => !isDirectory(row.content));
  console.log(`\nFilas actuales: ${rows.length} · se reemplazan ${replace.length} (de las páginas) por ${newChunks.length} nuevas · se quedan ${keep.length} (directorio: ${keep.length - orphans.length})`);
  for (const row of orphans) console.log(`  ⚠️ se queda sin reemplazo (no es directorio ni de las páginas): ${row.content.slice(0, 100)}…`);

  // 4. Offline comparison.
  console.log(`\nGenerando embeddings de ${newChunks.length} chunks y de las preguntas…`);
  const fresh: Row[] = [];
  for (const [i, content] of newChunks.entries()) fresh.push({ id: `new-${i}`, content, embedding: await generateEmbedding(content) });
  const { questions } = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../eval/retrieval-questions.json"), "utf8")) as { questions: Question[] };
  const queryVectors = new Map<string, number[]>();
  for (const question of questions) queryVectors.set(question.id, await generateEmbedding(question.q));

  const before = evaluate(rows, questions, queryVectors);
  const after = evaluate([...keep, ...fresh], questions, queryVectors);
  const pct = (n: number) => `${Math.round((100 * n) / questions.length)}%`.padStart(4);
  const en = questions.filter((q) => q.lang === "en");
  const enPct = (r: typeof before) => `${Math.round((100 * en.filter((q) => r.perQuestion[q.id]).length) / en.length)}%`;
  console.log(`\n                      hit@3  hit@10  contexto-app  (inglés)`);
  console.log(`chunks actuales       ${pct(before.hit3)}   ${pct(before.hit10)}     ${pct(before.context)}        ${enPct(before)}`);
  console.log(`chunks nuevos         ${pct(after.hit3)}   ${pct(after.hit10)}     ${pct(after.context)}        ${enPct(after)}`);
  const lostQuestions = questions.filter((q) => before.perQuestion[q.id] && !after.perQuestion[q.id]).map((q) => q.id);
  const gained = questions.filter((q) => !before.perQuestion[q.id] && after.perQuestion[q.id]).map((q) => q.id);
  console.log(`ganadas: ${gained.join(", ") || "-"}\nperdidas: ${lostQuestions.join(", ") || "-"}`);

  // 5. SQL for the Supabase SQL editor.
  const sqlFile = backupArg.replace(/\.json$/, ".reingest.sql");
  const sql = [
    "-- Generated by scripts/reingestPages.ts. Paste into Supabase → SQL Editor → Run.",
    "-- Replaces the SENASICA page chunks with the new ones, all or nothing. The vet directory is not touched.",
    "begin;",
    "do $$",
    "declare deleted int;",
    "begin",
    `  delete from public.documents where id in (${replace.map((row) => sqlString(row.id)).join(", ")});`,
    "  get diagnostics deleted = row_count;",
    `  if deleted <> ${replace.length} then raise exception 'Expected to delete ${replace.length} rows, got %. Nothing was changed.', deleted; end if;`,
    "end $$;",
    "insert into public.documents (content, embedding) values",
    fresh.map((row) => `  (${sqlString(row.content)}, '[${row.embedding.join(",")}]')`).join(",\n") + ";",
    "commit;",
    "",
  ].join("\n");
  fs.writeFileSync(sqlFile, sql);
  console.log(`\nSQL: ${path.relative(process.cwd(), sqlFile)} (${(sql.length / 1024).toFixed(0)} KB). No se cambió nada en la base.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
