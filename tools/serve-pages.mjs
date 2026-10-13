// 本地预览在线版：npm run pages:serve → http://127.0.0.1:8799/label-print-enhancer/
// 用和 GitHub Pages 一样的子路径，提前发现相对路径/service worker 作用域问题。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { build, OUT } from './build-pages.mjs';

export const PORT = Number(process.env.PAGES_PORT || 8799);
export const BASE = '/label-print-enhancer/';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.pfb': 'application/octet-stream', '.bcmap': 'application/octet-stream',
};

export function startServer({ rebuild = true, port = PORT } = {}) {
  if (rebuild) build();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(BASE)) {
      res.writeHead(302, { Location: BASE }).end();
      return;
    }
    let rel = decodeURIComponent(url.pathname.slice(BASE.length)) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(OUT, rel));
    if (!file.startsWith(OUT + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (!(await stat(file)).isFile()) throw new Error('not a file');
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1]?.endsWith('serve-pages.mjs')) {
  await startServer();
  console.log(`在线版预览：http://127.0.0.1:${PORT}${BASE}`);
}
