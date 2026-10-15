// 可视化调整的坐标换算（纯函数，有单测）：框选区域 ↔ 纸上内容框 ↔ 设置。单位：源页面用 pt，纸张用 mm。
import { paperPagePt, MM_PER_INCH, PT_PER_INCH } from './layout.js';

const MM_PER_PT = MM_PER_INCH / PT_PER_INCH;
const round1 = (v) => Math.round(v * 10) / 10;

/** 输出页面（= 纸张）的实际尺寸 mm（按 Chrome 取整后的 pt 算）。 */
export function paperMm(settings) {
  const page = paperPagePt(settings.paperW, settings.paperH);
  return Object.freeze({ w: page.w * MM_PER_PT, h: page.h * MM_PER_PT });
}

/** 要摆到纸上的源区域（pt）：有框选用框选，没有用整页。 */
export function sourceRect(settings, srcW, srcH) {
  return settings.crop ?? Object.freeze({ x: 0, y: 0, w: srcW, h: srcH });
}

/** 比例模式下，源区域在纸上的位置和大小（mm）。 */
export function contentBoxOnPaper(settings, src) {
  const paper = paperMm(settings);
  const k = (MM_PER_PT * settings.scale) / 100;
  const w = src.w * k;
  const h = src.h * k;
  const centered = settings.align === 'center';
  return Object.freeze({
    x: (centered ? (paper.w - w) / 2 : 0) + settings.marginLeft,
    y: (centered ? (paper.h - h) / 2 : 0) + settings.marginTop,
    w,
    h,
  });
}

/** 纸上内容框（mm）→ 设置：比例 + 左上边距（左上对齐、比例模式）。返回要合并的字段。 */
export function settingsFromBox(src, box) {
  return Object.freeze({
    fitMode: 'scale',
    align: 'top-left',
    scale: round1((box.w / (src.w * MM_PER_PT)) * 100),
    marginLeft: round1(box.x),
    marginTop: round1(box.y),
  });
}

/** 内容框靠近纸张中线（threshold mm 内）时吸附居中，返回吸附后的框和居中状态。 */
export function snapToCenter(box, paper, threshold = 1.5) {
  const dx = paper.w / 2 - (box.x + box.w / 2);
  const dy = paper.h / 2 - (box.y + box.h / 2);
  const centeredX = Math.abs(dx) <= threshold;
  const centeredY = Math.abs(dy) <= threshold;
  return Object.freeze({
    box: Object.freeze({ ...box, x: centeredX ? box.x + dx : box.x, y: centeredY ? box.y + dy : box.y }),
    centeredX,
    centeredY,
  });
}

/** 源区域等比放大/缩小到纸张内（四周留 padding mm）并居中。 */
export function fitBoxToPaper(src, paper, padding = 2) {
  const availW = Math.max(1, paper.w - 2 * padding);
  const availH = Math.max(1, paper.h - 2 * padding);
  const k = Math.min(availW / src.w, availH / src.h);
  const w = src.w * k;
  const h = src.h * k;
  return Object.freeze({ x: (paper.w - w) / 2, y: (paper.h - h) / 2, w, h });
}

/** 以 (cx, cy) 为中心等比缩放内容框（滚轮/按钮缩放用）。 */
export function zoomBox(box, factor, cx = box.x + box.w / 2, cy = box.y + box.h / 2) {
  return Object.freeze({
    x: cx - (cx - box.x) * factor,
    y: cy - (cy - box.y) * factor,
    w: box.w * factor,
    h: box.h * factor,
  });
}

/** 两点拉出的矩形，夹在 [0,maxW]×[0,maxH] 内。 */
export function rectFromPoints(a, b, maxW, maxH) {
  const clamp = (v, max) => Math.min(max, Math.max(0, v));
  const x1 = clamp(Math.min(a.x, b.x), maxW);
  const y1 = clamp(Math.min(a.y, b.y), maxH);
  const x2 = clamp(Math.max(a.x, b.x), maxW);
  const y2 = clamp(Math.max(a.y, b.y), maxH);
  return Object.freeze({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
}

/** 矩形整体平移后夹回范围内（不改变大小）。 */
export function clampRect(rect, maxW, maxH) {
  const w = Math.min(rect.w, maxW);
  const h = Math.min(rect.h, maxH);
  return Object.freeze({
    x: Math.min(maxW - w, Math.max(0, rect.x)),
    y: Math.min(maxH - h, Math.max(0, rect.y)),
    w,
    h,
  });
}

export const ptToMm = (pt) => pt * MM_PER_PT;
export const mmToPt = (mm) => mm / MM_PER_PT;
