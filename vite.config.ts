import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Serve api/explain.ts and api/propose.ts during `npm run dev`, so local dev matches Vercel.
const ROUTES = new Set(['explain', 'propose']);

function devApi(): Plugin {
  return {
    name: 'reglens-dev-api',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api', async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const name = (req.url ?? '').replace(/^\//, '').split(/[?#]/)[0];
        if (!ROUTES.has(name)) return next();
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const mod = await server.ssrLoadModule(`/api/${name}.ts`);
        const response: Response = await mod.POST(
          new Request(`http://localhost/api/${name}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: Buffer.concat(chunks),
          }),
        );
        res.statusCode = response.status;
        response.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(Buffer.from(await response.arrayBuffer()));
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Make .env values (NVIDIA_API_KEY, NVIDIA_MODEL) visible to the dev API handler.
  const env = loadEnv(mode, process.cwd(), '');
  for (const [k, v] of Object.entries(env)) process.env[k] ??= v;
  return { plugins: [react(), devApi()] };
});
