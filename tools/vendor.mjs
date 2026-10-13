// 把 pdf.js / pdf-lib 的浏览器构建拷进 lib/（扩展不能直接引用 node_modules）。
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const lib = join(root, 'lib');

const copies = [
  ['pdfjs-dist/build/pdf.min.mjs', 'pdfjs/pdf.min.mjs'],
  ['pdfjs-dist/build/pdf.worker.min.mjs', 'pdfjs/pdf.worker.min.mjs'],
  ['pdfjs-dist/cmaps', 'pdfjs/cmaps'],
  ['pdfjs-dist/standard_fonts', 'pdfjs/standard_fonts'],
  ['pdfjs-dist/LICENSE', 'pdfjs/LICENSE'],
  ['pdf-lib/dist/pdf-lib.esm.min.js', 'pdf-lib/pdf-lib.esm.min.js'],
  ['pdf-lib/LICENSE.md', 'pdf-lib/LICENSE.md'],
];

rmSync(lib, { recursive: true, force: true });
for (const [from, to] of copies) {
  const src = join(nm, from);
  if (!existsSync(src)) {
    console.error(`缺少 ${from}，先运行 npm install`);
    process.exit(1);
  }
  const dest = join(lib, to);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log(`✓ ${from} → lib/${to}`);
}
