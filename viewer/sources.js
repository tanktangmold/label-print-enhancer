// 源文件：PDF（pdf.js）和图片。合并后的文档 = { sources: [源文件…], pages: [页面引用…] }。
// 图片包装成和 pdf.js 页对象一样的接口（rotate / getViewport / render / cleanup），渲染代码不用区分。
import * as pdfjsLib from '../lib/pdfjs/pdf.min.mjs';
import { assetUrl } from '../core/platform.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = assetUrl('lib/pdfjs/pdf.worker.min.mjs');

const PDFJS_OPTIONS = Object.freeze({
  cMapUrl: assetUrl('lib/pdfjs/cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: assetUrl('lib/pdfjs/standard_fonts/'),
  isEvalSupported: false, // 扩展页 CSP 不允许 eval
});

export const IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']);
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const A4 = Object.freeze({ w: 595.28, h: 841.89 });
const PT_PER_CSS_PX = 0.75; // 图片按 96dpi 换算成 pt

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

export async function openPdfSource(bytes) {
  const pdf = await openPdf(bytes);
  return Object.freeze({ kind: 'pdf', pdf, numPages: pdf.numPages, destroy: () => pdf.destroy() });
}

/** 图片当成一页：按 96dpi 换算尺寸，比 A4 大就等比缩到 A4 以内。 */
export async function openImageSource(blob) {
  const bitmap = await createImageBitmap(blob);
  const w = bitmap.width * PT_PER_CSS_PX;
  const h = bitmap.height * PT_PER_CSS_PX;
  const k = Math.min(1, A4.w / w, A4.h / h);
  return Object.freeze({ kind: 'image', bitmap, w: w * k, h: h * k, numPages: 1, destroy: () => bitmap.close() });
}

function imagePage(src) {
  return {
    rotate: 0,
    getViewport({ scale = 1, rotation = 0, offsetX = 0, offsetY = 0 } = {}) {
      const r = ((rotation % 360) + 360) % 360;
      const turned = r % 180 !== 0;
      return { width: (turned ? src.h : src.w) * scale, height: (turned ? src.w : src.h) * scale, scale, rotation: r, offsetX, offsetY };
    },
    render({ canvasContext: ctx, viewport, background }) {
      ctx.save();
      if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      }
      const { scale: s, rotation: r, offsetX, offsetY } = viewport;
      const W = src.w * s;
      const H = src.h * s;
      ctx.translate(offsetX, offsetY);
      if (r === 90) {
        ctx.translate(H, 0);
        ctx.rotate(Math.PI / 2);
      } else if (r === 180) {
        ctx.translate(W, H);
        ctx.rotate(Math.PI);
      } else if (r === 270) {
        ctx.translate(0, W);
        ctx.rotate(-Math.PI / 2);
      }
      ctx.drawImage(src.bitmap, 0, 0, W, H);
      ctx.restore();
      return { promise: Promise.resolve(), cancel() {} };
    },
    cleanup() {},
  };
}

/** 取页面引用对应的页对象（pdf.js 页，或图片的同接口包装）。 */
export async function getPage(doc, ref) {
  const src = doc.sources[ref.src];
  if (!src) throw new Error(`missing source ${ref.src}`);
  return src.kind === 'pdf' ? src.pdf.getPage(ref.pageNo) : imagePage(src);
}

/** 这一页最终的旋转：PDF 自带 + 全局设置 + 这一页单独转的。 */
export function rotationOf(page, settings, ref) {
  return (((page.rotate + settings.rotate + (ref.rotate || 0)) % 360) + 360) % 360;
}

export function isImageFile(file) {
  return IMAGE_TYPES.includes(file?.type);
}
