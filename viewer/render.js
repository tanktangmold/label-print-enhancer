// 渲染：把合并文档里的某一页按版面画到「纸张大小」的画布上（含编辑对象、水印）；输出时逐页转灰度位图嵌进新 PDF。
// 文档 doc = { sources, pages }；页面引用 ref = { id, src, pageNo, rotate }（见 core/pages.js）。
import {
  PDFDocument,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  drawObject,
} from '../lib/pdf-lib/pdf-lib.esm.min.js';
import { computePlacement, binarize, findContentBBox, toPdfGray } from '../core/layout.js';
import { getPage, rotationOf } from './sources.js';
import { itemBox, mergeRuns } from '../core/text-runs.js';
import { turnRect } from '../core/edits.js';
import { drawOverlays, drawWatermark } from './overlays.js';

const BBOX_DPI = 144;
// 按「打印」意图渲染：PDF 里只在打印时出现的内容（注释打印标志、打印层）也会画出来
const RENDER_INTENT = 'print';

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** 释放画布显存/内存。 */
export function releaseCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

/** 渲染被取消（换设置/换文件）时抛出的错误，调用方静默忽略即可。 */
export function isCancelled(err) {
  return err?.name === 'RenderingCancelledException' || err?.name === 'AbortError';
}

async function renderTo(page, ctx, viewport, signal) {
  signal?.throwIfAborted();
  const task = page.render({ canvasContext: ctx, viewport, intent: RENDER_INTENT, background: '#ffffff' });
  const cancel = () => task.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    await task.promise;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

async function withPage(doc, ref, fn) {
  const page = await getPage(doc, ref);
  try {
    return await fn(page);
  } finally {
    page.cleanup();
  }
}

/** 编辑对象的画法参数：对象存的是编辑视图里的页面坐标，排版设置的旋转在这里转过去。 */
function overlayOpts(page, settings, ref) {
  const vp = page.getViewport({ scale: 1, rotation: rotationOf(page, { rotate: 0 }, ref) });
  return { turn: settings.rotate, base: { w: vp.width, h: vp.height } };
}

/** 低分辨率渲染一遍（含编辑对象：加的文字、图片也算内容，盖白的不算），找出有内容的区域（pt，原点左上）。 */
async function detectContentBBox(page, rotation, signal, paint = () => {}) {
  const scale = BBOX_DPI / 72;
  const viewport = page.getViewport({ scale, rotation });
  const canvas = makeCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    await renderTo(page, ctx, viewport, signal);
    paint(ctx, scale);
    const box = findContentBBox(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
    return box && { x: box.x / scale, y: box.y / scale, w: box.w / scale, h: box.h / scale };
  } finally {
    releaseCanvas(canvas);
  }
}

/** 框选区域以外涂白（只打印框内）。 */
function whiteOutside(ctx, clip, width, height) {
  const x2 = clip.x + clip.w;
  const y2 = clip.y + clip.h;
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, Math.max(0, clip.y));
  ctx.fillRect(0, y2, width, Math.max(0, height - y2));
  ctx.fillRect(0, clip.y, Math.max(0, clip.x), clip.h);
  ctx.fillRect(x2, clip.y, Math.max(0, width - x2), clip.h);
  ctx.restore();
}

function binarizeCanvas(ctx, canvas, threshold) {
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  binarize(img.data, threshold);
  ctx.putImageData(img, 0, 0);
}

/** 自动识别页面上有内容的区域（pt），整页空白返回 null。框选视图的初始选区用。 */
export function detectContent(doc, ref, settings, signal, objects = []) {
  return withPage(doc, ref, (page) => {
    const opts = overlayOpts(page, settings, ref);
    return detectContentBBox(page, rotationOf(page, settings, ref), signal, (ctx, scale) => drawOverlays(ctx, objects, { scale, ...opts }));
  });
}

/**
 * 页面上原有的文字段（pt，左上原点，含旋转）。图片、扫描件没有文字层，返回空数组。
 * 先按没单独转过的方向找（文字是横的，才能按行拼接），再跟着单页旋转转过去。
 */
export function textRuns(doc, ref, settings) {
  return withPage(doc, ref, async (page) => {
    if (typeof page.getTextContent !== 'function') return [];
    const vp = page.getViewport({ scale: 1, rotation: rotationOf(page, settings, { ...ref, rotate: 0 }) });
    const content = await page.getTextContent();
    const style = (item) => content.styles?.[item.fontName] ?? {};
    const boxes = content.items.map((item) => itemBox(item, vp.transform, { serif: style(item).fontFamily === 'serif', vertical: !!style(item).vertical }));
    const runs = mergeRuns(boxes.filter(Boolean));
    const turn = (((ref.rotate || 0) % 360) + 360) % 360;
    if (!turn) return runs;
    const base = { w: vp.width, h: vp.height };
    return Object.freeze(runs.map((r) => Object.freeze({ ...r, ...turnRect(r, turn, base) })));
  });
}

/** 页面尺寸（pt，已含旋转）。 */
export function sourceSize(doc, ref, settings) {
  return withPage(doc, ref, (page) => {
    const vp = page.getViewport({ scale: 1, rotation: rotationOf(page, settings, ref) });
    return { w: vp.width, h: vp.height };
  });
}

/**
 * 编辑/框选视图用的快速渲染：把页面的 rect 区域（pt；不传 = 整页）画成宽 pixelWidth 的画布。
 * 不做排版。objects 是要画上去的编辑对象；mono=false 时保留原色（编辑时看得清楚）。
 */
export function renderRegion(doc, ref, settings, pixelWidth, rect = null, signal, { objects = [], mono = settings.mono } = {}) {
  signal?.throwIfAborted();
  return withPage(doc, ref, async (page) => {
    const rotation = rotationOf(page, settings, ref);
    const full = page.getViewport({ scale: 1, rotation });
    const r = rect ?? { x: 0, y: 0, w: full.width, h: full.height };
    const scale = pixelWidth / r.w;
    const canvas = makeCanvas(Math.max(1, Math.round(r.w * scale)), Math.max(1, Math.round(r.h * scale)));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const offX = -r.x * scale;
    const offY = -r.y * scale;
    await renderTo(page, ctx, page.getViewport({ scale, rotation, offsetX: offX, offsetY: offY }), signal);
    drawOverlays(ctx, objects, { scale, offX, offY, ...overlayOpts(page, settings, ref) });
    if (mono) binarizeCanvas(ctx, canvas, settings.threshold);
    return canvas;
  });
}

/**
 * 把一页按设置排到一张纸上，返回 { canvas, placement }。
 * 顺序：页面 → 编辑对象（盖白/文字/图片/马赛克）→ 框外涂白 → 黑白二值化 → 水印。
 */
export function renderLabelPage(doc, ref, settings, signal, { objects = [] } = {}) {
  signal?.throwIfAborted();
  return withPage(doc, ref, async (page) => {
    const rotation = rotationOf(page, settings, ref);
    const base = page.getViewport({ scale: 1, rotation });
    // 有框选区域时以框为准，不用再检测内容
    const opts = overlayOpts(page, settings, ref);
    const paint = (ctx, scale) => drawOverlays(ctx, objects, { scale, ...opts });
    const bbox = settings.fitMode === 'auto' && !settings.crop ? await detectContentBBox(page, rotation, signal, paint) : null;
    const placement = computePlacement({ settings, srcW: base.width, srcH: base.height, bbox });

    const canvas = makeCanvas(placement.canvasW, placement.canvasH);
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const viewport = page.getViewport({ scale: placement.scale, rotation, offsetX: placement.offX, offsetY: placement.offY });
      await renderTo(page, ctx, viewport, signal);
      drawOverlays(ctx, objects, { scale: placement.scale, offX: placement.offX, offY: placement.offY, ...opts });
      if (placement.clip) whiteOutside(ctx, placement.clip, canvas.width, canvas.height);
      if (settings.mono) binarizeCanvas(ctx, canvas, settings.threshold);
      drawWatermark(ctx, settings.watermark, { width: canvas.width, height: canvas.height, pxPerPt: placement.dpi / 72, mono: settings.mono });
      return { canvas, placement };
    } catch (err) {
      releaseCanvas(canvas);
      throw err;
    }
  });
}

/** 整页灰度位图贴满页面（PDF 图像坐标：单位方块 → 页面大小）。 */
function addImagePage(pdfDoc, canvas, placement, mono) {
  const { canvasW: w, canvasH: h } = placement;
  const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const image = pdfDoc.context.flateStream(toPdfGray(pixels, w, h, mono), {
    Type: 'XObject',
    Subtype: 'Image',
    Width: w,
    Height: h,
    ColorSpace: 'DeviceGray',
    BitsPerComponent: mono ? 1 : 8,
  });
  const page = pdfDoc.addPage([placement.page.w, placement.page.h]);
  const name = page.node.newXObject('Label', pdfDoc.context.register(image));
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(placement.page.w, 0, 0, placement.page.h, 0, 0),
    drawObject(name),
    popGraphicsState(),
  );
}

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 生成输出 PDF：按页面列表的顺序，每页 = 纸张大小，整页一张灰度图。
 * objectsFor(ref) 返回这一页要画的编辑对象。逐页渲染→嵌入→释放画布，内存只占一页。
 */
export async function buildLabelPdf({ doc, settings, objectsFor = () => [], title, onProgress = () => {}, signal }) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(title);
  pdfDoc.setCreator('PrintPal');
  const n = doc.pages.length;
  for (let i = 0; i < n; i++) {
    onProgress(i + 1, n);
    const ref = doc.pages[i];
    const { canvas, placement } = await renderLabelPage(doc, ref, settings, signal, { objects: objectsFor(ref) });
    try {
      addImagePage(pdfDoc, canvas, placement, settings.mono);
    } finally {
      releaseCanvas(canvas);
    }
    await nextTick(); // 让进度文字有机会刷新
  }
  return pdfDoc.save();
}
