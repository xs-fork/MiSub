import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/[[path]].js';

const rootDir = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number.parseInt(process.env.PORT || '8787', 10) || 8787;
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function createAssetBinding() {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const requestedPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const safePath = normalize(requestedPath).replace(/^([.][.][/\\])+/, '');
      const filePath = join(rootDir, safePath.replace(/^[/\\]+/, ''));
      try {
        const body = await readFile(filePath);
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream' }
        });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    }
  };
}

const env = {
  ...process.env,
  MISUB_RUNTIME: 'container',
  MISUB_STORAGE_TYPE: 'sqlite',
  ASSETS: createAssetBinding()
};

const server = http.createServer(async (nodeRequest, nodeResponse) => {
  try {
    const host = nodeRequest.headers.host || `127.0.0.1:${port}`;
    const requestUrl = `http://${host}${nodeRequest.url || '/'}`;
    const request = new Request(requestUrl, {
      method: nodeRequest.method,
      headers: nodeRequest.headers,
      body: ['GET', 'HEAD'].includes(nodeRequest.method) ? undefined : nodeRequest,
      duplex: 'half'
    });
    const backgroundTasks = [];
    const response = await onRequest({
      request,
      env,
      next: () => env.ASSETS.fetch(request),
      waitUntil: promise => {
        const task = Promise.resolve(promise).catch(error => {
          console.warn('[NodeServer] waitUntil:', error?.message || error);
        });
        backgroundTasks.push(task);
      }
    });

    if (backgroundTasks.length > 0) {
      await Promise.allSettled(backgroundTasks);
    }

    nodeResponse.writeHead(response.status, Object.fromEntries(response.headers));
    if (nodeRequest.method === 'HEAD' || !response.body) {
      nodeResponse.end();
      return;
    }
    const body = Buffer.from(await response.arrayBuffer());
    nodeResponse.end(body);
  } catch (error) {
    console.error('[NodeServer] Request failed:', error);
    nodeResponse.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    nodeResponse.end(JSON.stringify({ error: 'Internal Server Error', message: error?.message || String(error) }));
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[NodeServer] listening on :${port}`);
});