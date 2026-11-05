// 编辑对象（盖白、马赛克、文字、图片）和水印：数据校验与纯操作。
// 坐标单位 pt，原点在页面（含旋转后）的左上角。所有函数返回新对象，不改传入的数据。

export const OBJECT_TYPES = Object.freeze(['whiteout', 'mosaic', 'text', 'image']);
// 能「每页同位置」并跟着打印方案保存的类型（文字、图片只对当前文件）
export const GLOBAL_TYPES = Object.freeze(['whiteout', 'mosaic']);
export const MAX_GLOBAL_OVERLAYS = 30;
export const DEFAULT_WATERMARK = Object.freeze({
  enabled: false,
  text: 'SAMPLE',
  size: 40,
  opacity: 0.25,
  angle: -30,
  color: '#808080',
});

const MAX_COORD = 7000;
const MIN_SIZE = 1;
const COLOR = /^#[0-9a-f]{6}$/i;
const round2 = (v) => Math.round(v * 100) / 100;

function num(value, min, max, fallback) {
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** 校验一个编辑对象；不合法返回 null。 */
export function normalizeObject(o) {
  if (!o || typeof o !== 'object' || !OBJECT_TYPES.includes(o.type) || typeof o.id !== 'string' || !o.id) return null;
  const rect = ['x', 'y', 'w', 'h'].map((k) => Number(o[k]));
  if (!rect.every(Number.isFinite)) return null;
  const [x, y, w, h] = rect;
  if (w < MIN_SIZE || h < MIN_SIZE || w > MAX_COORD || h > MAX_COORD || Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) return null;
  const base = { id: o.id.slice(0, 40), type: o.type, x: round2(x), y: round2(y), w: round2(w), h: round2(h) };
  switch (o.type) {
    case 'mosaic':
      return Object.freeze({ ...base, block: num(o.block, 2, 40, 6) });
    case 'text':
      return Object.freeze({
        ...base,
        text: String(o.text ?? '').slice(0, 2000),
        size: num(o.size, 4, 200, 10),
        color: COLOR.test(o.color ?? '') ? o.color.toLowerCase() : '#000000',
        bold: o.bold === true,
        cover: o.cover !== false,
      });
    case 'image':
      return typeof o.imageId === 'string' && o.imageId ? Object.freeze({ ...base, imageId: o.imageId }) : null;
    default:
      return Object.freeze(base);
  }
}

/** 方案里保存的「每页同位置」对象：只收盖白 / 马赛克，最多 30 个，id 去重。 */
export function normalizeOverlays(list) {
  if (!Array.isArray(list)) return Object.freeze([]);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const o = normalizeObject(raw);
    if (!o || !GLOBAL_TYPES.includes(o.type) || seen.has(o.id)) continue;
    seen.add(o.id);
    out.push(o);
    if (out.length >= MAX_GLOBAL_OVERLAYS) break;
  }
  return Object.freeze(out);
}

export function normalizeWatermark(w) {
  const src = w && typeof w === 'object' ? w : {};
  const text = typeof src.text === 'string' ? src.text.replace(/[\r\n]+/g, ' ').slice(0, 60) : DEFAULT_WATERMARK.text;
  return Object.freeze({
    enabled: src.enabled === true,
    text,
    size: num(src.size, 6, 200, DEFAULT_WATERMARK.size),
    opacity: num(src.opacity, 0.05, 1, DEFAULT_WATERMARK.opacity),
    angle: num(src.angle, -90, 90, DEFAULT_WATERMARK.angle),
    color: COLOR.test(src.color ?? '') ? src.color.toLowerCase() : DEFAULT_WATERMARK.color,
  });
}

// ---------- 每页的编辑内容：{ [pageId]: [对象…] } ----------

export function addObject(edits, pageId, obj) {
  const clean = normalizeObject(obj);
  if (!clean) return edits;
  return Object.freeze({ ...edits, [pageId]: Object.freeze([...(edits[pageId] ?? []), clean]) });
}

/** 改对象（位置、文字等）；改完不合法就保持原样。 */
export function updateObject(edits, pageId, id, patch) {
  const list = edits[pageId];
  if (!list) return edits;
  let changed = false;
  const next = list.map((o) => {
    if (o.id !== id) return o;
    const clean = normalizeObject({ ...o, ...patch, id: o.id, type: o.type });
    if (!clean) return o;
    changed = true;
    return clean;
  });
  return changed ? Object.freeze({ ...edits, [pageId]: Object.freeze(next) }) : edits;
}

export function removeObject(edits, pageId, id) {
  const list = edits[pageId];
  if (!list) return edits;
  return Object.freeze({ ...edits, [pageId]: Object.freeze(list.filter((o) => o.id !== id)) });
}

/** 复制一页时，把它的编辑内容也复制给新页（对象换新 id）。 */
export function copyEdits(edits, fromPageId, toPageId, makeId) {
  const list = edits[fromPageId];
  if (!list?.length) return edits;
  return Object.freeze({ ...edits, [toPageId]: Object.freeze(list.map((o) => Object.freeze({ ...o, id: makeId() }))) });
}

/** 某一页要画的全部对象：先画方案里的「每页同位置」对象，再画这一页自己的。 */
export function objectsFor(edits, pageId, overlays = []) {
  return Object.freeze([...overlays, ...(edits[pageId] ?? [])]);
}

/** 点中的对象（后画的在上面，优先选中）；没点中返回 null。 */
export function hitTest(objects, pt) {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (pt.x >= o.x && pt.x <= o.x + o.w && pt.y >= o.y && pt.y <= o.y + o.h) return o;
  }
  return null;
}

// ---------- 旋转：对象坐标跟着页面转 ----------

/** 矩形随页面顺时针转 turn 度（0/90/180/270）后的位置；page = 转之前的页面尺寸 pt。 */
export function turnRect(r, turn, page) {
  switch (turn) {
    case 90:
      return { x: page.h - (r.y + r.h), y: r.x, w: r.h, h: r.w };
    case 180:
      return { x: page.w - (r.x + r.w), y: page.h - (r.y + r.h), w: r.w, h: r.h };
    case 270:
      return { x: r.y, y: page.w - (r.x + r.w), w: r.h, h: r.w };
    default:
      return { x: r.x, y: r.y, w: r.w, h: r.h };
  }
}

/**
 * 页面转了 turn 度以后，这页上的对象跟着走：盖白 / 马赛克整块跟着转（还盖在原来那块内容上），
 * 文字 / 图片保持正向，只把中心点移到转后的位置。
 */
export function turnObjects(objects, turn, page) {
  return Object.freeze(
    objects.map((o) => {
      const r = turnRect(o, turn, page);
      const next = GLOBAL_TYPES.includes(o.type)
        ? { ...o, ...r }
        : { ...o, x: r.x + r.w / 2 - o.w / 2, y: r.y + r.h / 2 - o.h / 2 };
      return normalizeObject(next) ?? o;
    }),
  );
}

/** 某一页转了以后，返回新的 edits（只动这一页）。 */
export function turnPageEdits(edits, pageId, turn, page) {
  const list = edits[pageId];
  if (!list?.length) return edits;
  return Object.freeze({ ...edits, [pageId]: turnObjects(list, turn, page) });
}
