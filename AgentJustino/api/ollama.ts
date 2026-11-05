// Vercel function: same-origin proxy from the browser to the Ollama host.
// vercel.json rewrites /ollama/<path> to /api/ollama?path=<path>.
// All checks (path + model allowlist, limits, auth header) live in lib/ollamaProxy.ts.
import { handleOllamaProxy } from "../lib/ollamaProxy.ts";

function handle(request: Request): Promise<Response> {
  const path = new URL(request.url).searchParams.get("path") ?? "";
  return handleOllamaProxy(request, path, process.env);
}

export const GET = handle;
export const POST = handle;
