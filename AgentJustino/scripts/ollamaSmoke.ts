// Smoke test before a demo: one embedding call and one chat call per answer model.
// Run: npm run smoke
//   chat  → Ollama Cloud (OLLAMA_API_KEY from .env), or OLLAMA_CHAT_BASE_URL
//   embed → OLLAMA_BASE_URL, default http://localhost:11434
// Pass --chat-only to skip the embedding call.
import { OllamaError, ollamaChat, resolveChatBaseUrl, resolveEmbedModel, resolveOllamaBaseUrl } from "../lib/ollama.ts";
import { generateEmbedding } from "../lib/embeddings.ts";
import { getAnswerModels } from "../lib/chat.ts";
import { buildChatMessages } from "../lib/prompt.ts";

const QUESTION = "¿Qué necesito para llevar a mi perro de México a Estados Unidos en avión?";
const CONTEXT =
  "[1] Para ingresar a Estados Unidos, los perros deben presentar un certificado de vacunación antirrábica vigente " +
  "y contar con microchip. [2] Los perros deben verse sanos a la llegada y tener al menos 6 meses de edad.";

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  console.log(`${label}: ${Math.round(performance.now() - start)} ms`);
  return result;
}

async function main() {
  console.log(`Chat: ${resolveChatBaseUrl()} · Embeddings: ${resolveOllamaBaseUrl()}\n`);

  if (!process.argv.includes("--chat-only")) {
    try {
      const vector = await timed(`embed (${resolveEmbedModel()})`, () => generateEmbedding(QUESTION));
      console.log(`  ${vector.length} dimensiones ✅\n`);
    } catch (error) {
      process.exitCode = 1;
      console.error(`  ❌ embed: ${error instanceof Error ? error.message : error}\n`);
    }
  }

  let failures = 0;
  for (const model of getAnswerModels()) {
    try {
      const answer = await timed(`chat (${model})`, () =>
        ollamaChat(buildChatMessages(CONTEXT, QUESTION, []), { model, numCtx: 4096, timeoutMs: 180000 }),
      );
      console.log(`  ${answer.trim().replace(/\n/g, "\n  ")}\n`);
    } catch (error) {
      failures++;
      const kind = error instanceof OllamaError ? ` [${error.kind}${error.status ? ` ${error.status}` : ""}]` : "";
      console.error(`  ❌${kind} ${error instanceof Error ? error.message : error}\n`);
      // Same account for every model: no point trying the next one.
      if (error instanceof OllamaError && ["auth", "credits", "rate_limited"].includes(error.kind)) break;
    }
  }

  if (failures === getAnswerModels().length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
