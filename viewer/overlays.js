// 把编辑对象画到画布上：盖白、图片、文字（可带白底盖住原字）、马赛克；水印画在整张纸上。
// 输出是整页图像，所以马赛克、盖白之后原来的内容在打印件和下载的 PDF 里都真的没了。
import { pixelate, wrapLines } from '../core/pixel.js';
import { turnRect } from '../core/edits.js';
import { getImage } from './images.js';

export const FONT_STACK = '"Noto Sans JP","Yu Gothic UI","Yu Gothic",Meiryo,"Microsoft YaHei UI","PingFang SC","Hiragino Sans",sans-serif';
const LINE_HEIGHT = 1.25;
const TEXT_PAD = 0.15; // 文字框内边距（相对字号）

function fillWhite(ctx, r) {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}

function drawText(ctx, o, r, scale) {
  ctx.save();
  if (o.cover) fillWhite(ctx, r);
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  const px = o.size * scale;
  const pad = px * TEXT_PAD;
  ctx.font = `${o.bold ? 'bold ' : ''}${px}px ${FONT_STACK}`;
  ctx.fillStyle = o.color;
  ctx.textBaseline = 'top';
  const lines = wrapLines(o.text, Math.max(1, r.w - pad * 2), (s) => ctx.measureText(s).width);
  lines.forEach((line, i) => ctx.fillText(line, r.x + pad, r.y + pad + i * px * LINE_HEIGHT));
  ctx.restore();
}

function pixelateRegion(ctx, r, block) {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const x2 = Math.min(ctx.canvas.width, Math.ceil(r.x + r.w));
  const y2 = Math.min(ctx.canvas.height, Math.ceil(r.y + r.h));
  if (x2 <= x || y2 <= y) return;
  const img = ctx.getImageData(x, y, x2 - x, y2 - y);
  pixelate(img.data, img.width, img.height, Math.max(2, block));
  ctx.putImageData(img, x, y);
}

/** 文字 / 图片跟着页面一起转：在转后的位置上旋转画布再画（盖白、马赛克是轴对齐矩形，不用转）。 */
function drawTurned(ctx, r, turn, draw) {
  if (!turn) return draw(r);
  const swap = turn === 90 || turn === 270;
  const w = swap ? r.h : r.w;
  const h = swap ? r.w : r.h;
  ctx.save();
  ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
  ctx.rotate((turn * Math.PI) / 180);
  draw({ x: -w / 2, y: -h / 2, w, h });
  ctx.restore();
}

/**
 * 画编辑对象。对象坐标是「编辑视图里的页面」pt（含 PDF 自带和单页旋转，不含排版设置里的旋转）；
 * turn = 排版设置的旋转，base = 编辑视图里的页面尺寸。再按 scale（px/pt）和偏移换成画布像素（和 pdf.js 视口一致）。
 */
export function drawOverlays(ctx, objects, { scale, offX = 0, offY = 0, turn = 0, base = null }) {
  for (const o of objects) {
    const t = turn && base ? turnRect(o, turn, base) : o;
    const r = { x: offX + t.x * scale, y: offY + t.y * scale, w: t.w * scale, h: t.h * scale };
    if (o.type === 'whiteout') fillWhite(ctx, r);
    else if (o.type === 'mosaic') pixelateRegion(ctx, r, o.block * scale);
    else if (o.type === 'text') drawTurned(ctx, r, turn, (rr) => drawText(ctx, o, rr, scale));
    else if (o.type === 'image') {
      const img = getImage(o.imageId);
      if (img) drawTurned(ctx, r, turn, (rr) => ctx.drawImage(img.bitmap, rr.x, rr.y, rr.w, rr.h));
    }
  }
}

/**
 * 水印：纸张正中、按角度旋转。黑白（热敏）模式下半透明会被二值化成实心黑块，所以改画空心字。
 */
export function drawWatermark(ctx, wm, { width, height, pxPerPt, mono }) {
  if (!wm?.enabled || !wm.text.trim()) return;
  const px = wm.size * pxPerPt;
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate((wm.angle * Math.PI) / 180);
  ctx.font = `bold ${px}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (mono) {
    ctx.lineWidth = Math.max(1, px * 0.035);
    ctx.strokeStyle = '#000000';
    ctx.strokeText(wm.text, 0, 0);
  } else {
    ctx.globalAlpha = wm.opacity;
    ctx.fillStyle = wm.color;
    ctx.fillText(wm.text, 0, 0);
  }
  ctx.restore();
}
