import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const FAL_HOST = /(^|\.)fal\.(ai|run|media)$/;

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function fail(res: ServerResponse, status: number, msg: string) {
  res.statusCode = status;
  res.end(msg);
}

/**
 * fal proxy for local use: the browser never sees the key. Implements fal's proxy protocol
 * (`x-fal-target-url`) plus a media passthrough for result images. The key comes from FAL_KEY.
 */
function falProxy(): Plugin {
  return {
    name: 'trompe-fal-proxy',
    configureServer(server) {
      server.middlewares.use('/api/fal/proxy', async (req, res) => {
        const key = process.env.FAL_KEY;
        const target = req.headers['x-fal-target-url'];
        if (!key) return fail(res, 500, 'FAL_KEY is not set where the dev server runs');
        if (typeof target !== 'string') return fail(res, 400, 'missing x-fal-target-url');
        if (!FAL_HOST.test(new URL(target).hostname)) return fail(res, 403, 'target host not allowed');
        const headers: Record<string, string> = { authorization: `Key ${key}`, accept: 'application/json' };
        for (const [k, v] of Object.entries(req.headers)) {
          if (k.startsWith('x-fal-') && k !== 'x-fal-target-url' && typeof v === 'string') headers[k] = v;
        }
        if (typeof req.headers['content-type'] === 'string') headers['content-type'] = req.headers['content-type'];
        const method = req.method ?? 'GET';
        try {
          const r = await fetch(target, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(await body(req)) });
          res.statusCode = r.status;
          const ct = r.headers.get('content-type');
          if (ct) res.setHeader('content-type', ct);
          res.end(Buffer.from(await r.arrayBuffer()));
        } catch (e) {
          fail(res, 502, `proxy error: ${(e as Error).message}`);
        }
      });
      // Saves run artefacts under ./runs/<id>/<file> (dev server only; names are restricted to [\w.-]).
      server.middlewares.use('/api/runs', async (req, res) => {
        if (req.method !== 'POST') return fail(res, 405, 'POST only');
        const parts = decodeURIComponent((req.url ?? '').replace(/^\/+/, '').split('?')[0]).split('/');
        const safe = /^[\w.-]+$/;
        if (parts.length !== 2 || !parts.every((p) => safe.test(p) && p !== '..' && p !== '.')) return fail(res, 400, 'bad path');
        const root = path.resolve(server.config.root, 'runs');
        const dir = path.join(root, parts[0]);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, parts[1]), await body(req));
        res.statusCode = 204;
        res.end();
      });
      server.middlewares.use('/api/fal/media', async (req, res) => {
        const url = new URL(req.url ?? '', 'http://x').searchParams.get('url');
        if (!url || !FAL_HOST.test(new URL(url).hostname)) return fail(res, 400, 'bad media url');
        try {
          const r = await fetch(url);
          res.statusCode = r.status;
          res.setHeader('content-type', r.headers.get('content-type') ?? 'application/octet-stream');
          res.end(Buffer.from(await r.arrayBuffer()));
        } catch (e) {
          fail(res, 502, `media fetch error: ${(e as Error).message}`);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [falProxy()],
  server: { port: 5178, strictPort: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
