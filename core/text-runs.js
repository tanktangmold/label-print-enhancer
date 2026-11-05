// PDF 页面上的原有文字：把 pdf.js getTextContent 的文字项换算成页面坐标（pt，左上原点，含旋转），
// 同一行里挨着的拼成一段，供「点文字 → 删除 / 修改」用。不改原 PDF：删除 = 盖白，修改 = 盖白 + 重写。

const ASCENT = 0.9; // 字身上沿（相对字号）
const DESCENT = 0.22; // 字身下沿
const SAME_LINE = 0.35; // 行中心相差不到 0.35 个字号算同一行
const MAX_GAP = 1.05; // 同一行里间隔不超过约 1 个字号拼成一段（姓名常隔一个全角空格；再远就是表格的另一格）
const SPACE_GAP = 0.25; // 间隔超过 0.25 个字号时拼接处补一个空格

/** 两个 2D 仿射矩阵相乘（pdf.js 的 [a, b, c, d, e, f] 形式）：先 m2 再 m1。 */
export function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * 一个文字项 → 页面上的外接矩形。viewportTransform 是 scale=1 的视口变换（含旋转）。
 * 竖排（vertical）时 pdf.js 给的是没转的矩阵、width = 字号、height = 整列长度：和它的文字层一样转 90° 处理。
 * 返回 { str, x, y, w, h, size, serif, horizontal }；空白项返回 null。
 */
export function itemBox(item, viewportTransform, { serif = false, vertical = false } = {}) {
  if (typeof item?.str !== 'string' || !item.str.trim() || !Array.isArray(item.transform)) return null;
  const tx = multiply(viewportTransform, item.transform);
  const size = Math.hypot(tx[2], tx[3]);
  const len = Math.hypot(tx[0], tx[1]);
  const width = Number(vertical ? item.height : item.width);
  if (!(size > 0) || !(len > 0) || !Number.isFinite(width)) return null;
  const turn = (v) => (vertical ? { x: -v.y, y: v.x } : v); // 竖排：方向顺时针转 90°（往下走）
  const d = turn({ x: tx[0] / len, y: tx[1] / len }); // 文字前进方向
  const u = turn({ x: tx[2] / size, y: tx[3] / size }); // 字的「向上」方向（画布坐标，y 向下）
  const o = { x: tx[4], y: tx[5] }; // 基线起点
  const at = (along, up) => ({ x: o.x + d.x * along + u.x * up, y: o.y + d.y * along + u.y * up });
  const pts = [at(0, -DESCENT * size), at(width, -DESCENT * size), at(0, ASCENT * size), at(width, ASCENT * size)];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    str: item.str,
    x,
    y,
    w: Math.max(...xs) - x,
    h: Math.max(...ys) - y,
    size,
    serif,
    horizontal: Math.abs(d.y) < 0.01 && d.x > 0,
  };
}

function joinRun(run, b) {
  const gap = b.x - (run.x + run.w);
  const right = Math.max(run.x + run.w, b.x + b.w);
  const top = Math.min(run.y, b.y);
  const bottom = Math.max(run.y + run.h, b.y + b.h);
  const space = gap > SPACE_GAP * run.size && !run.str.endsWith(' ') && !b.str.startsWith(' ') ? ' ' : '';
  return { ...run, str: run.str + space + b.str, y: top, w: right - run.x, h: bottom - top, size: Math.max(run.size, b.size) };
}

/** 把一行里的文字项按 x 排好，挨得近、字号差不多的拼成一段。 */
function mergeLine(line) {
  const runs = [];
  for (const b of [...line].sort((a, c) => a.x - c.x)) {
    const run = runs.at(-1);
    const gap = run ? b.x - (run.x + run.w) : Infinity;
    const similar = run && Math.abs(run.size - b.size) <= 0.25 * Math.max(run.size, b.size);
    if (run && similar && gap > -0.3 * run.size && gap < MAX_GAP * run.size) runs[runs.length - 1] = joinRun(run, b);
    else runs.push(b);
  }
  return runs;
}

/** 文字项 → 文字段：横排的按行拼接，其他方向（竖排、旋转）各自一段。 */
export function mergeRuns(boxes) {
  const horizontal = boxes.filter((b) => b.horizontal).sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
  const lines = [];
  for (const b of horizontal) {
    const line = lines.at(-1);
    const center = b.y + b.h / 2;
    if (line && Math.abs(center - line.center) < SAME_LINE * Math.min(b.size, line.size)) line.items.push(b);
    else lines.push({ center, size: b.size, items: [b] });
  }
  const runs = [...lines.flatMap((l) => mergeLine(l.items)), ...boxes.filter((b) => !b.horizontal)];
  return Object.freeze(
    runs.map((r) =>
      Object.freeze({ str: r.str.trim(), x: r.x, y: r.y, w: r.w, h: r.h, size: Math.round(r.size * 10) / 10, serif: r.serif }),
    ),
  );
}

/** 点中的文字段（外扩 pad pt 容差；重叠时取最小的）。 */
export function hitRun(runs, pt, pad = 1) {
  let best = null;
  for (const r of runs) {
    const inside = pt.x >= r.x - pad && pt.x <= r.x + r.w + pad && pt.y >= r.y - pad && pt.y <= r.y + r.h + pad;
    if (inside && (!best || r.w * r.h < best.w * best.h)) best = r;
  }
  return best;
}
