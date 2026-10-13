// 生成扩展图标（红底 + 白色标签 + 条码），无需任何图形库：手写最小 PNG 编码。
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const RED = [229, 72, 59, 255];
const WHITE = [255, 255, 255, 255];
const BLACK = [31, 35, 40, 255];
const CLEAR = [0, 0, 0, 0];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) raw.set(pixel(x, y), y * (size * 4 + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function iconPixel(size) {
  const r = size * 0.2; // 圆角
  const bars = [0, 2, 3, 5, 7, 8, 10, 13, 14, 16, 18, 19]; // 条码图案（20 格里哪些是黑条）
  return (x, y) => {
    const u = (x + 0.5) / size;
    const v = (y + 0.5) / size;
    const dx = Math.max(r - (x + 0.5), x + 0.5 - (size - r), 0);
    const dy = Math.max(r - (y + 0.5), y + 0.5 - (size - r), 0);
    if (dx * dx + dy * dy > r * r) return CLEAR;
    const inLabel = u > 0.16 && u < 0.84 && v > 0.24 && v < 0.76;
    if (!inLabel) return RED;
    const inBarcode = u > 0.24 && u < 0.76 && v > 0.42 && v < 0.68;
    if (inBarcode && bars.includes(Math.floor(((u - 0.24) / 0.52) * 20))) return BLACK;
    const inTitle = u > 0.24 && u < 0.6 && v > 0.3 && v < 0.36;
    return inTitle ? BLACK : WHITE;
  };
}

mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(outDir, `${size}.png`), encodePng(size, iconPixel(size)));
  console.log(`✓ icons/${size}.png`);
}
