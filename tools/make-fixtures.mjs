// 生成测试用 PDF：模拟「A4 竖版、送り状标签印在左上角」的版式（真实文件的结构推断自 Chrome 预览截图）。
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');
const MM = 72 / 25.4;
const A4 = [595.28, 841.89];

/** 在页面左上角画一张 105×60mm 的假标签（坐标按左上原点给，内部换算成 PDF 左下原点）。 */
function drawLabel(page, font, n) {
  const H = page.getHeight();
  const box = (xMm, yMm, wMm, hMm, opts) =>
    page.drawRectangle({ x: xMm * MM, y: H - (yMm + hMm) * MM, width: wMm * MM, height: hMm * MM, ...opts });
  const text = (s, xMm, yMm, size) => page.drawText(s, { x: xMm * MM, y: H - yMm * MM - size, size, font });

  box(3, 3, 104, 58, { borderColor: rgb(0, 0, 0), borderWidth: 1 });
  box(4, 4, 24, 5, { color: rgb(0, 0, 0) });
  text(`123-4567   LABEL ${n}`, 40, 6, 16);
  text('Sample-ku Test-cho 1-2-3', 40, 14, 8);
  for (let i = 0; i < 18; i++) box(5 + i * 1.3, 18, i % 3 === 0 ? 0.9 : 0.5, 14, { color: rgb(0, 0, 0) });
  for (let i = 0; i < 40; i++) box(5 + i * 1.0, 38, i % 2 ? 0.6 : 0.35, 14, { color: rgb(0, 0, 0) });
  text('Sender: Example Shop', 52, 40, 7);
  text('YD02', 96, 54, 8); // 标签右下角（约 105mm 处），被切掉时一眼能看出来
}

async function makeA4(rotate) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let n = 1; n <= 3; n++) {
    const page = doc.addPage(A4);
    drawLabel(page, font, n);
    if (rotate) page.setRotation(degrees(rotate));
  }
  return doc.save();
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'a4-label.pdf'), await makeA4(0));
writeFileSync(join(outDir, 'a4-label-rot90.pdf'), await makeA4(90));
console.log('✓ tests/fixtures/a4-label.pdf, a4-label-rot90.pdf');
