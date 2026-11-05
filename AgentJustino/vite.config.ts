import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import type { IncomingMessage } from 'node:http'
import { handleOllamaProxy, type ProxyEnv } from './lib/ollamaProxy.ts'

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/**
 * Dev: serve /ollama/* with the same proxy code as production (api/ollama.ts), so
 * chat goes to Ollama Cloud with OLLAMA_API_KEY added here, server-side, and
 * embeddings go to the local Ollama. The key never reaches the browser.
 */
function ollamaDevProxy(env: ProxyEnv): Plugin {
  return {
    name: 'ollama-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/ollama', async (req, res) => {
        const path = (req.url ?? '').split('?')[0]
        const body = req.method === 'POST' ? await readBody(req) : undefined
        const request = new Request(`http://localhost${req.url ?? ''}`, { method: req.method, body })
        const response = await handleOllamaProxy(request, path, env)
        res.statusCode = response.status
        res.setHeader('Content-Type', response.headers.get('Content-Type') ?? 'application/json')
        res.end(await response.text())
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // '' prefix: also load non-VITE_ variables (OLLAMA_API_KEY) for server-side use only.
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [
      react(),
      ollamaDevProxy({
        ...env,
        OLLAMA_EMBED_UPSTREAM_URL: env.OLLAMA_EMBED_UPSTREAM_URL || env.OLLAMA_BASE_URL || 'http://localhost:11434',
      }),
    ],
  }
})
