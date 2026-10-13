// 生成在线演示/截图用的示例送り状 samples/sample-label.pdf：A4 竖版，标签印在左上角（和真实ゆうパケット送り状同样的版式）。
// 全部是虚构数据。字体用 Noto Sans JP（SIL OFL），第一次运行自动下载到 tools/.fonts/（不进仓库）。
// pdf-lib 自带的子集化会丢字，所以先用 subset-font（HarfBuzz）切出只含用到字符的小字体，再整体嵌入。
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import subsetFont from 'subset-font';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONT_DIR = join(root, 'tools', '.fonts');
// 老 Safari 的 UA 才能从 Google Fonts 拿到 TTF（新浏览器给 woff2，IE 给 EOT）
const OLD_SAFARI = 'Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; en-us) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1';
const MM = 72 / 25.4;
const A4 = [595.28, 841.89];

async function fontBytes(weight) {
  const file = join(FONT_DIR, `NotoSansJP-${weight}.ttf`);
  if (!existsSync(file)) {
    mkdirSync(FONT_DIR, { recursive: true });
    const css = await (await fetch(`https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@${weight}`, { headers: { 'User-Agent': OLD_SAFARI } })).text();
    const url = /url\((https:[^)]+\.ttf)\)/.exec(css)?.[1];
    if (!url) throw new Error('Google Fonts 没返回 TTF 地址');
    writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
    console.log(`↓ ${url}`);
  }
  return readFileSync(file);
}

const LABELS = [
  { zip: '〒123−4567', addr: ['東京都サンプル区見本町1−2−3', 'テストハイツ101号室'], name: '見本　太郎　様', item: '品名／ サンプル商品 2点', code: 'a1234567890123a' },
  { zip: '〒234−5678', addr: ['神奈川県テスト市例示町4−5−6', '（宅配ボックスに配達してください）'], name: '試験　花子　様', item: '品名／ テスト用品 1点', code: 'a2345678901234a' },
  { zip: '〒345−6789', addr: ['大阪府サンプル市見本通7−8−9', 'サンプルビル3階'], name: 'Sample Company 御中', item: '品名／ 見本 3点', code: 'a3456789012345a' },
];

// 标签上固定的文字（子集化时要包含）
const FIXED_TEXT = '料　金　後　納ゆうパケット0123456789−【差出人・返還先】〒京都府見本市サンプル町株式会社商店　テスト担当SAMPLE/ 見本XX01';

/** 决定性的伪条码（只是看起来像条码，不能扫描）。 */
function bars(seed, count) {
  let x = seed;
  return Array.from({ length: count }, () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return 1 + (x % 3);
  });
}

function drawLabel(page, fonts, data, index) {
  const H = page.getHeight();
  const black = rgb(0, 0, 0);
  const box = (x, y, w, h, opts) => page.drawRectangle({ x: x * MM, y: H - (y + h) * MM, width: w * MM, height: h * MM, ...opts });
  // 纯英数字用 Helvetica：子集化后的日文字体排 ASCII 数字时字距会被拉开
  const pick = (s, bold) => (/^[\x20-\x7e]+$/.test(s) ? (bold ? fonts.latinBold : fonts.latin) : bold ? fonts.bold : fonts.regular);
  const text = (s, x, y, size, { bold = false, color = black } = {}) =>
    page.drawText(s, { x: x * MM, y: H - y * MM - size * 0.88, size, font: pick(s, bold), color });
  const barcode = (x, y, w, h, seed, n) => {
    const widths = bars(seed, n);
    const unit = w / widths.reduce((a, b) => a + b * 2, 0);
    let cx = x;
    for (const bw of widths) {
      box(cx, y, bw * unit, h, { color: black });
      cx += bw * unit * 2;
    }
  };

  // 左上：料金後納 / ゆうパケット / 区分番号
  box(3, 3, 26, 6, { borderColor: black, borderWidth: 1 });
  text('料　金　後　納', 4.2, 3.8, 10, { bold: true });
  box(3, 9.5, 26, 6, { color: black });
  text('ゆうパケット', 4.3, 10.4, 11.5, { bold: true, color: rgb(1, 1, 1) });
  text(`12−34−5${index + 1}`, 4, 17, 13, { bold: true });
  barcode(3.5, 24, 22, 16, 7 + index, 14);

  // 右上：郵便番号・住所・宛名
  text(data.zip, 46, 3.5, 20, { bold: true });
  text(data.addr[0], 32, 13.5, 8);
  text(data.addr[1], 32, 17.5, 8);
  text(data.name, 32, 25, 8.5, { bold: true });
  text(data.item, 32, 29.5, 7.5);
  barcode(32, 34, 68, 3.5, 31 + index, 60);

  // 下段：追跡番号バーコード + 差出人
  barcode(3, 43, 46, 13, 101 + index, 34);
  text(data.code, 14, 57, 6.5);
  text('【差出人・返還先】〒987−6543', 52, 44, 7, { bold: true });
  text('京都府見本市サンプル町1−1−1', 52, 48, 6);
  text('株式会社サンプル商店　テスト担当', 52, 52.5, 6);
  text('000−0000−0000', 62, 56, 6);
  text('SAMPLE / 見本', 84, 60, 6.5, { bold: true, color: rgb(0.85, 0.15, 0.15) });
  text('XX01', 98, 56, 8, { bold: true });
}

async function main() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle('Sample shipping label (fictitious data)');
  doc.setCreator('Label Print Enhancer – tools/make-sample.mjs');
  const usedText = JSON.stringify(LABELS) + FIXED_TEXT;
  const embed = async (weight) =>
    doc.embedFont(await subsetFont(await fontBytes(weight), usedText, { targetFormat: 'truetype' }), { subset: false });
  const fonts = {
    regular: await embed(400),
    bold: await embed(700),
    latin: await doc.embedFont(StandardFonts.Helvetica),
    latinBold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  LABELS.forEach((data, i) => drawLabel(doc.addPage(A4), fonts, data, i));
  mkdirSync(join(root, 'samples'), { recursive: true });
  const bytes = await doc.save();
  writeFileSync(join(root, 'samples', 'sample-label.pdf'), bytes);
  console.log(`✓ samples/sample-label.pdf（${LABELS.length} 页，${bytes.length} 字节）`);
}

main().catch((err) => {
  console.error('✖', err.message);
  process.exit(1);
});
