// 渲染：pdf.js 把源页面按版面画到「纸张大小」的画布上；输出时逐页转灰度位图嵌进新 PDF。
import * as pdfjsLib from '../lib/pdfjs/pdf.min.mjs';
import {
  PDFDocument,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  drawObject,
} from '../lib/pdf-lib/pdf-lib.esm.min.js';
import { computePlacement, binarize, findContentBBox, toPdfGray } from '../core/layout.js';
import { assetUrl } from '../core/platform.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = assetUrl('lib/pdfjs/pdf.worker.min.mjs');

const PDFJS_OPTIONS = Object.freeze({
  cMapUrl: assetUrl('lib/pdfjs/cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: assetUrl('lib/pdfjs/standard_fonts/'),
  isEvalSupported: false, // 扩展页 CSP 不允许 eval
});

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

/** 打开 PDF。pdf.js 会接管传入的缓冲区，所以传副本；打开失败要销毁任务，否则泄漏 Worker。 */
export async function openPdf(bytes) {
  const task = pdfjsLib.getDocument({ ...PDFJS_OPTIONS, data: bytes.slice() });
  try {
    return await task.promise;
  } catch (err) {
    await task.destroy().catch(() => {});
    throw err;
  }
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

/** 低分辨率渲染一遍，找出有内容的区域（pt，原点左上）。 */
async function detectContentBBox(page, rotation, signal) {
  const scale = BBOX_DPI / 72;
  const viewport = page.getViewport({ scale, rotation });
  const canvas = makeCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    await renderTo(page, ctx, viewport, signal);
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

/** 自动识别页面上有内容的区域（pt），整页空白返回 null。框选视图的初始选区用。 */
export async function detectContent(pdf, pageNo, settings, signal) {
  const page = await pdf.getPage(pageNo);
  try {
    return await detectContentBBox(page, (page.rotate + settings.rotate) % 360, signal);
  } finally {
    page.cleanup();
  }
}

/** 源页面尺寸（pt，已含旋转）。 */
export async function sourceSize(pdf, pageNo, settings) {
  const page = await pdf.getPage(pageNo);
  const vp = page.getViewport({ scale: 1, rotation: (page.rotate + settings.rotate) % 360 });
  return { w: vp.width, h: vp.height };
}

/**
 * 可视化编辑用的快速渲染：把源页面的 rect 区域（pt；不传 = 整页）画成宽 pixelWidth 的画布。
 * 不做排版，只给框选视图（整页）和拖动调整时的内容层用。
 */
export async function renderRegion(pdf, pageNo, settings, pixelWidth, rect = null, signal) {
  signal?.throwIfAborted();
  const page = await pdf.getPage(pageNo);
  try {
    const rotation = (page.rotate + settings.rotate) % 360;
    const full = page.getViewport({ scale: 1, rotation });
    const r = rect ?? { x: 0, y: 0, w: full.width, h: full.height };
    const scale = pixelWidth / r.w;
    const canvas = makeCanvas(Math.max(1, Math.round(r.w * scale)), Math.max(1, Math.round(r.h * scale)));
    const ctx = canvas.getContext('2d', { willReadFrequently: settings.mono });
    const viewport = page.getViewport({ scale, rotation, offsetX: -r.x * scale, offsetY: -r.y * scale });
    await renderTo(page, ctx, viewport, signal);
    if (settings.mono) {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      binarize(img.data, settings.threshold);
      ctx.putImageData(img, 0, 0);
    }
    return canvas;
  } finally {
    page.cleanup();
  }
}

/** 把第 pageNo 页按设置排到一张纸上，返回 { canvas, placement }。signal 中止时取消渲染。 */
export async function renderLabelPage(pdf, pageNo, settings, signal) {
  signal?.throwIfAborted();
  const page = await pdf.getPage(pageNo);
  try {
    const rotation = (page.rotate + settings.rotate) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    // 有框选区域时以框为准，不用再检测内容
    const bbox = settings.fitMode === 'auto' && !settings.crop ? await detectContentBBox(page, rotation, signal) : null;
    const placement = computePlacement({ settings, srcW: base.width, srcH: base.height, bbox });

    const canvas = makeCanvas(placement.canvasW, placement.canvasH);
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const viewport = page.getViewport({ scale: placement.scale, rotation, offsetX: placement.offX, offsetY: placement.offY });
      await renderTo(page, ctx, viewport, signal);
      if (placement.clip) whiteOutside(ctx, placement.clip, canvas.width, canvas.height);
      if (settings.mono) {
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        binarize(img.data, settings.threshold);
        ctx.putImageData(img, 0, 0);
      }
      return { canvas, placement };
    } catch (err) {
      releaseCanvas(canvas);
      throw err;
    }
  } finally {
    page.cleanup();
  }
}

/** 整页灰度位图贴满页面（PDF 图像坐标：单位方块 → 页面大小）。 */
function addImagePage(doc, canvas, placement, mono) {
  const { canvasW: w, canvasH: h } = placement;
  const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const image = doc.context.flateStream(toPdfGray(pixels, w, h, mono), {
    Type: 'XObject',
    Subtype: 'Image',
    Width: w,
    Height: h,
    ColorSpace: 'DeviceGray',
    BitsPerComponent: mono ? 1 : 8,
  });
  const page = doc.addPage([placement.page.w, placement.page.h]);
  const name = page.node.newXObject('Label', doc.context.register(image));
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(placement.page.w, 0, 0, placement.page.h, 0, 0),
    drawObject(name),
    popGraphicsState(),
  );
}

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 生成输出 PDF：每页 = 纸张大小（ゆうパケット 2 → 横向 314×241pt），整页一张灰度图。
 * 页面方向和纸张一致，Chrome 就不会再「按源页面方向转纸」把标签切掉。
 * 逐页渲染→嵌入→释放画布，不进预览缓存，内存只占一页。
 */
export async function buildLabelPdf({ pdf, settings, title, onProgress = () => {}, signal }) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator('Label Print Enhancer');
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress(i, pdf.numPages);
    const { canvas, placement } = await renderLabelPage(pdf, i, settings, signal);
    try {
      addImagePage(doc, canvas, placement, settings.mono);
    } finally {
      releaseCanvas(canvas);
    }
    await nextTick(); // 让进度文字有机会刷新
  }
  return doc.save();
}
