import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  paperPagePt,
  computePlacement,
  binarize,
  findContentBBox,
  fileBaseName,
  looksLikePdf,
  mmToPx,
  effectiveDpi,
  toPdfGray,
  MAX_CANVAS_PIXELS,
  PAPER_PRESETS,
} from '../core/layout.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('默认设置复刻付费工具：ゆうパケット 2 / 93% / 上2mm 左0 / 400dpi 黑白', () => {
  const s = normalizeSettings({});
  assert.equal(s.paperW, 111.0);
  assert.equal(s.paperH, 85.1);
  assert.equal(s.scale, 93);
  assert.equal(s.marginTop, 2);
  assert.equal(s.marginLeft, 0);
  assert.equal(s.dpi, 400);
  assert.equal(s.mono, true);
  assert.ok(Object.isFrozen(s));
});

test('normalizeSettings 夹紧非法数值、拒绝非法枚举、不改输入', () => {
  const input = { scale: '9999', dpi: -5, fitMode: 'evil', rotate: '90', mono: 'yes', threshold: 'abc' };
  const s = normalizeSettings(input);
  assert.equal(s.scale, 800);
  assert.equal(s.dpi, 150);
  assert.equal(s.fitMode, DEFAULT_SETTINGS.fitMode);
  assert.equal(s.rotate, 90);
  assert.equal(s.mono, DEFAULT_SETTINGS.mono);
  assert.equal(s.threshold, DEFAULT_SETTINGS.threshold);
  assert.deepEqual(input, { scale: '9999', dpi: -5, fitMode: 'evil', rotate: '90', mono: 'yes', threshold: 'abc' });
});

test('预设纸张覆盖宽高，自定义纸张保留输入宽高', () => {
  assert.equal(normalizeSettings({ paper: '4x6', paperW: 50 }).paperW, 101.6);
  const custom = normalizeSettings({ paper: 'custom', paperW: 100, paperH: 50 });
  assert.equal(custom.paperW, 100);
  assert.equal(custom.paperH, 50);
});

test('页面尺寸向下取整到整数 pt，不超过 Chrome 认定的纸张', () => {
  const p = paperPagePt(111.0, 85.1);
  assert.deepEqual({ ...p }, { w: 314, h: 241 });
  assert.ok(p.w > p.h, 'ゆうパケット 2 输出必须是横向页面，Chrome 才不会把纸转成竖的');
});

test('自定义比例模式：左上对齐 + 边距换算正确', () => {
  const settings = normalizeSettings({});
  const pl = computePlacement({ settings, srcW: 595, srcH: 842 });
  near(pl.scale, (400 / 72) * 0.93);
  near(pl.offX, 0);
  near(pl.offY, mmToPx(2, 400));
  assert.equal(pl.canvasW, Math.round((314 / 72) * 400));
  assert.equal(pl.canvasH, Math.round((241 / 72) * 400));
  assert.equal(pl.percent, 93);
});

test('居中对齐：内容居中，边距作为微调偏移', () => {
  const settings = normalizeSettings({ align: 'center', marginTop: 0, marginLeft: 0, scale: 100 });
  const pl = computePlacement({ settings, srcW: 100, srcH: 50 });
  near(pl.offX + (100 * pl.scale) / 2, pl.canvasW / 2);
  near(pl.offY + (50 * pl.scale) / 2, pl.canvasH / 2);
});

test('自动适配：内容框等比放满可用区并居中', () => {
  const settings = normalizeSettings({ fitMode: 'auto', autoPadding: 0 });
  const bbox = { x: 10, y: 20, w: 300, h: 100 };
  const pl = computePlacement({ settings, srcW: 595, srcH: 842, bbox });
  const left = pl.offX + bbox.x * pl.scale;
  const right = left + bbox.w * pl.scale;
  const top = pl.offY + bbox.y * pl.scale;
  const bottom = top + bbox.h * pl.scale;
  assert.ok(left >= -1e-6 && right <= pl.canvasW + 1e-6);
  assert.ok(top >= -1e-6 && bottom <= pl.canvasH + 1e-6);
  // 至少一个方向贴边（放满）
  assert.ok(Math.abs(right - left - pl.canvasW) < 1e-6 || Math.abs(bottom - top - pl.canvasH) < 1e-6);
  near((left + right) / 2, pl.canvasW / 2);
  near((top + bottom) / 2, pl.canvasH / 2);
});

test('自动适配找不到内容时回落到比例模式', () => {
  const settings = normalizeSettings({ fitMode: 'auto' });
  const pl = computePlacement({ settings, srcW: 595, srcH: 842, bbox: null });
  assert.equal(pl.percent, 93);
});

test('binarize 按阈值转纯黑白且不透明', () => {
  const data = new Uint8ClampedArray([10, 10, 10, 0, 200, 200, 200, 128, 127, 127, 127, 255]);
  binarize(data, 128);
  assert.deepEqual([...data], [0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
});

test('findContentBBox 找到非白区域，空白页返回 null', () => {
  const w = 5;
  const h = 4;
  const white = new Uint8ClampedArray(w * h * 4).fill(255);
  assert.equal(findContentBBox(white, w, h), null);
  const data = new Uint8ClampedArray(white);
  const dot = (x, y) => data.set([0, 0, 0, 255], (y * w + x) * 4);
  dot(1, 1);
  dot(3, 2);
  assert.deepEqual({ ...findContentBBox(data, w, h) }, { x: 1, y: 1, w: 3, h: 2 });
});

test('fileBaseName 解码日文文件名并去掉 .pdf', () => {
  const url = 'https://x.example/customer/1/pdffiles/JP_%E9%80%81%E3%82%8A%E7%8A%B6.pdf?X-Amz=1';
  assert.equal(fileBaseName(url), 'JP_送り状');
  assert.equal(fileBaseName('not a url'), 'label');
});

test('looksLikePdf 识别 PDF 头', () => {
  assert.equal(looksLikePdf(new TextEncoder().encode('%PDF-1.4\n...')), true);
  assert.equal(looksLikePdf(new TextEncoder().encode('<html>403</html>')), false);
  assert.equal(looksLikePdf(null), false);
});

test('清空数字框不会变成最小值：回落到当前设置（base）', () => {
  const current = normalizeSettings({ scale: 88 });
  const s = normalizeSettings({ scale: '', marginTop: '  ' }, current);
  assert.equal(s.scale, 88);
  assert.equal(s.marginTop, current.marginTop);
  assert.equal(normalizeSettings({ fitMode: 'evil' }, normalizeSettings({ fitMode: 'auto' })).fitMode, 'auto');
});

test('画布像素超上限时自动降 dpi，标签纸常规尺寸不受影响', () => {
  assert.equal(effectiveDpi(600, paperPagePt(111, 85.1)), 600);
  const big = normalizeSettings({ paper: 'custom', paperW: 300, paperH: 400, dpi: 600 });
  const pl = computePlacement({ settings: big, srcW: 595, srcH: 842 });
  assert.ok(pl.dpi < 600);
  assert.ok(pl.canvasW * pl.canvasH <= MAX_CANVAS_PIXELS * 1.01, `${pl.canvasW}×${pl.canvasH}`);
  near(pl.scale, (pl.dpi / 72) * 0.93);
});

test('toPdfGray：1 位打包（1=白，按字节补齐）和 8 位灰度', () => {
  // 10×1：黑白交替
  const w = 10;
  const data = new Uint8ClampedArray(w * 4);
  for (let x = 0; x < w; x++) data.set(x % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], x * 4);
  assert.deepEqual([...toPdfGray(data, w, 1, true)], [0b01010101, 0b01000000]);
  assert.deepEqual([...toPdfGray(data, 2, 1, false)], [0, 255]);
});

test('所有纸张预设：id 唯一、尺寸在可输入范围内、选中后宽高生效', () => {
  const ids = PAPER_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of PAPER_PRESETS.filter((x) => x.w !== null)) {
    const s = normalizeSettings({ paper: p.id });
    assert.equal(s.paper, p.id);
    assert.equal(s.paperW, p.w, p.id);
    assert.equal(s.paperH, p.h, p.id);
    assert.ok(['label', 'paper'].includes(p.group));
  }
  assert.equal(PAPER_PRESETS.at(-1).id, 'custom');
});

test('界面语言设置只接受 auto/zh/en/ja', () => {
  assert.equal(normalizeSettings({}).lang, 'auto');
  assert.equal(normalizeSettings({ lang: 'ja' }).lang, 'ja');
  assert.equal(normalizeSettings({ lang: 'fr' }).lang, 'auto');
});

test('代码版本和 manifest 版本一致（排版页靠它判断后台是不是旧代码）', async () => {
  const { CODE_VERSION } = await import('../core/version.js');
  const { readFileSync } = await import('node:fs');
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(CODE_VERSION, manifest.version);
});
