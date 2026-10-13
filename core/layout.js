// 排版核心：纸张/坐标换算、设置校验、版面计算、二值化、内容边界检测。
// 纯函数，不依赖 DOM —— 扩展页面和 Node 单测共用。

export const MM_PER_INCH = 25.4;
export const PT_PER_INCH = 72;

// 纸张预设（宽 × 高，mm）。名称在 i18n 语言包里（paper.<id>），出处见 README。
// group：label 快递面单 / paper 常用纸张 / custom 自定义
const preset = (id, group, w, h) => Object.freeze({ id, group, w, h });
export const PAPER_PRESETS = Object.freeze([
  // 日本邮政 ゆうパケット：Xprinter 等标签机驱动内置尺寸
  preset('yupacket2', 'label', 111.0, 85.1),
  preset('yupacket', 'label', 111.0, 169.9),
  // ヤマト B2クラウド：官方 FAQ 给出的标签机纸张设置
  preset('yamato-hatsu', 'label', 115.6, 198.1),
  preset('yamato-collect', 'label', 115.6, 236.2),
  preset('yamato-mail', 'label', 113.6, 79.8),
  // 佐川 e飛伝Ⅲ：官方打印机设置手册（SATO CF408T）
  preset('sagawa-unified', 'label', 108.9, 215.5),
  preset('sagawa-tag', 'label', 103.9, 144.0),
  // 国际通用热敏面单
  preset('4x6', 'label', 101.6, 152.4),
  preset('4x4', 'label', 101.6, 101.6),
  preset('100x150', 'label', 100.0, 150.0),
  // 中国电子面单：一联单标准模板 / 二联单
  preset('cn-76x130', 'label', 76.0, 130.0),
  preset('cn-100x180', 'label', 100.0, 180.0),
  // 常用纸张
  preset('a4', 'paper', 210.0, 297.0),
  preset('a5', 'paper', 148.0, 210.0),
  preset('a6', 'paper', 105.0, 148.0),
  preset('b5', 'paper', 182.0, 257.0),
  preset('b6', 'paper', 128.0, 182.0),
  preset('letter', 'paper', 215.9, 279.4),
  preset('postcard', 'paper', 100.0, 148.0),
  preset('custom', 'custom', null, null),
]);

export const LANG_CHOICES = Object.freeze(['auto', 'zh', 'en', 'ja']);

// 默认值：日本邮政 ゆうパケット 2 实测可用的设置（93%、上边距 2mm、左边距 0、400dpi 黑白）
export const DEFAULT_SETTINGS = Object.freeze({
  paper: 'yupacket2',
  paperW: 111.0,
  paperH: 85.1,
  fitMode: 'scale', // 'scale' 自定义比例 | 'auto' 自动裁切适配
  scale: 93,
  marginTop: 2,
  marginLeft: 0,
  align: 'top-left', // 'top-left' | 'center'
  autoPadding: 2,
  rotate: 0,
  dpi: 400,
  mono: true,
  threshold: 128,
  autoTakeover: true,
  autoPrint: false,
  lang: 'auto',
  crop: null, // 框选的打印区域 {x,y,w,h}（pt，源页面左上为原点，已含旋转）；null = 整页
});

const NUMBER_LIMITS = Object.freeze({
  paperW: [20, 300],
  paperH: [20, 400],
  scale: [5, 800],
  marginTop: [-200, 200],
  marginLeft: [-200, 200],
  autoPadding: [0, 30],
  dpi: [150, 600],
  threshold: [1, 254],
});

const ENUMS = Object.freeze({
  paper: PAPER_PRESETS.map((p) => p.id),
  fitMode: ['scale', 'auto'],
  align: ['top-left', 'center'],
  rotate: [0, 90, 180, 270],
  lang: LANG_CHOICES,
});

const BOOLEANS = Object.freeze(['mono', 'autoTakeover', 'autoPrint']);

// 框选区域的合法范围（pt）：最小 3pt（约 1mm），坐标不超过 A0 的两倍
const CROP_MIN = 3;
const CROP_MAX = 7000;

/** 校验框选区域：四个有限数字、宽高够大，否则返回 null（= 整页）。 */
export function normalizeCrop(crop) {
  if (!crop || typeof crop !== 'object') return null;
  const vals = ['x', 'y', 'w', 'h'].map((k) => Number(crop[k]));
  if (!vals.every(Number.isFinite)) return null;
  const [x, y, w, h] = vals;
  if (w < CROP_MIN || h < CROP_MIN || Math.abs(x) > CROP_MAX || Math.abs(y) > CROP_MAX || w > CROP_MAX || h > CROP_MAX) return null;
  const round = (v) => Math.round(v * 100) / 100;
  return Object.freeze({ x: round(x), y: round(y), w: round(w), h: round(h) });
}

function clampNumber(value, [min, max], fallback) {
  // 空字符串 Number('') === 0，要当成无效，否则清空输入框会变成最小值
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 校验并补全设置：非法值回落到 base（默认是出厂设置；表单读取时传当前设置），数字夹到合法区间。返回新对象。
 */
export function normalizeSettings(input, base = DEFAULT_SETTINGS) {
  const src = input && typeof input === 'object' ? input : {};
  const out = { ...DEFAULT_SETTINGS, ...base };
  for (const [key, range] of Object.entries(NUMBER_LIMITS)) {
    if (key in src) out[key] = clampNumber(src[key], range, out[key]);
  }
  for (const [key, allowed] of Object.entries(ENUMS)) {
    const v = key === 'rotate' ? Number(src[key]) : src[key];
    if (allowed.includes(v)) out[key] = v;
  }
  for (const key of BOOLEANS) {
    if (typeof src[key] === 'boolean') out[key] = src[key];
  }
  if ('crop' in src) out.crop = normalizeCrop(src.crop);
  const preset = PAPER_PRESETS.find((p) => p.id === out.paper);
  if (preset && preset.w !== null) {
    out.paperW = preset.w;
    out.paperH = preset.h;
  }
  return Object.freeze(out);
}

// 单页画布像素上限（约 40MP ≈ 160MB RGBA），超了自动降清晰度，免得标签页崩溃
export const MAX_CANVAS_PIXELS = 40_000_000;

/** 纸张太大时把 dpi 降到画布不超过上限。 */
export function effectiveDpi(dpi, page) {
  const pixels = ptToPx(page.w, dpi) * ptToPx(page.h, dpi);
  if (pixels <= MAX_CANVAS_PIXELS) return dpi;
  return Math.floor(dpi * Math.sqrt(MAX_CANVAS_PIXELS / pixels));
}

export function mmToPx(mm, dpi) {
  return (mm / MM_PER_INCH) * dpi;
}

export function ptToPx(pt, dpi) {
  return (pt / PT_PER_INCH) * dpi;
}

/**
 * 输出 PDF 的页面尺寸（pt，取整向下）。
 * Chrome 打印时把纸张尺寸向下取整成整数 pt（pdfium_print.cc ToFlooredSize），
 * 页面不大于纸张就不会被「缩小以适应」再缩一次。
 */
export function paperPagePt(paperWmm, paperHmm) {
  return Object.freeze({
    w: Math.floor((paperWmm / MM_PER_INCH) * PT_PER_INCH),
    h: Math.floor((paperHmm / MM_PER_INCH) * PT_PER_INCH),
  });
}

/**
 * 计算一页的版面：画布像素尺寸 + 源页面渲染缩放(px/pt) + 偏移(px)。
 * srcW/srcH：源页面（已含旋转）尺寸，pt。
 * bbox：自动适配模式下的内容边界 {x,y,w,h}，pt，原点左上。
 * 设置里有 crop（框选区域）时：只打印框内内容；比例模式下边距/居中以框为准，自动模式把框铺满纸张。
 * 返回的 clip 是框在画布上的位置（px），框外要涂白。
 */
export function computePlacement({ settings, srcW, srcH, bbox = null }) {
  const crop = settings.crop ?? null;
  const base = computeBasePlacement({ settings, srcW, srcH, bbox: crop ?? bbox, origin: crop });
  if (!crop) return base;
  const clip = Object.freeze({
    x: base.offX + crop.x * base.scale,
    y: base.offY + crop.y * base.scale,
    w: crop.w * base.scale,
    h: crop.h * base.scale,
  });
  return Object.freeze({ ...base, clip });
}

function computeBasePlacement({ settings, srcW, srcH, bbox, origin }) {
  const s = settings;
  const page = paperPagePt(s.paperW, s.paperH);
  const dpi = effectiveDpi(s.dpi, page);
  const canvasW = Math.round(ptToPx(page.w, dpi));
  const canvasH = Math.round(ptToPx(page.h, dpi));
  const pxPerPt = dpi / PT_PER_INCH;

  if (s.fitMode === 'auto' && bbox && bbox.w > 0 && bbox.h > 0) {
    const pad = mmToPx(s.autoPadding, dpi);
    const availW = Math.max(1, canvasW - 2 * pad);
    const availH = Math.max(1, canvasH - 2 * pad);
    const k = Math.min(availW / bbox.w, availH / bbox.h);
    return Object.freeze({
      page,
      dpi,
      canvasW,
      canvasH,
      scale: k,
      offX: pad + (availW - bbox.w * k) / 2 - bbox.x * k,
      offY: pad + (availH - bbox.h * k) / 2 - bbox.y * k,
      percent: (k / pxPerPt) * 100,
    });
  }

  const k = (pxPerPt * s.scale) / 100;
  const marginX = mmToPx(s.marginLeft, dpi);
  const marginY = mmToPx(s.marginTop, dpi);
  const centered = s.align === 'center';
  // 定位基准：有框选时是框，没有时是整页
  const o = origin ?? { x: 0, y: 0, w: srcW, h: srcH };
  return Object.freeze({
    page,
    dpi,
    canvasW,
    canvasH,
    scale: k,
    offX: (centered ? (canvasW - o.w * k) / 2 + marginX : marginX) - o.x * k,
    offY: (centered ? (canvasH - o.h * k) / 2 + marginY : marginY) - o.y * k,
    percent: s.scale,
  });
}

function luminance(data, i) {
  return (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
}

/**
 * 黑白二值化。data 是 getImageData() 返回的像素副本（调用方独占），原地写回以省内存。
 * 热敏打印机只有黑/白两种点，提前二值化比让驱动抖动更清晰。
 */
export function binarize(data, threshold) {
  for (let i = 0; i < data.length; i += 4) {
    const v = luminance(data, i) < threshold ? 0 : 255;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  return data;
}

/**
 * RGBA 像素 → PDF 图像数据。mono：1 位灰度（1=白、0=黑，每行按字节补齐）；否则 8 位灰度。
 * 直接嵌进 PDF，比走 PNG 编码/解码省内存省时间，热敏机也只需要灰度。
 */
export function toPdfGray(data, width, height, mono) {
  if (!mono) {
    const out = new Uint8Array(width * height);
    for (let p = 0, i = 0; p < out.length; p++, i += 4) out[p] = Math.round(luminance(data, i));
    return out;
  }
  const rowBytes = Math.ceil(width / 8);
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (luminance(data, (y * width + x) * 4) >= 128) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

/** 找非白像素的包围盒（px），整页空白返回 null。 */
export function findContentBBox(data, width, height, threshold = 200) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (luminance(data, row + x * 4) < threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return Object.freeze({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
}

/** 从 URL 取文件名（去扩展名），失败返回 'label'。 */
export function fileBaseName(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    const name = decodeURIComponent(last).replace(/\.pdf$/i, '');
    return name || 'label';
  } catch {
    return 'label';
  }
}

/** 是否 PDF 文件头（%PDF-）。 */
export function looksLikePdf(bytes) {
  if (!bytes || bytes.length < 5) return false;
  // 有些服务器在文件头前塞了少量垃圾字节，前 1KB 内出现即可
  const head = String.fromCharCode(...bytes.subarray(0, Math.min(1024, bytes.length)));
  return head.includes('%PDF-');
}
