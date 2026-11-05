import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pixelate, wrapLines } from '../core/pixel.js';
import { makePages, movePage, removePage, duplicatePage, rotatePage, appendPages, keepEditsFor } from '../core/pages.js';
import {
  normalizeObject, normalizeOverlays, normalizeWatermark, addObject, updateObject, removeObject, copyEdits, objectsFor, hitTest,
  DEFAULT_WATERMARK, MAX_GLOBAL_OVERLAYS,
} from '../core/edits.js';
import { createHistory } from '../core/history.js';
import { normalizeSettings } from '../core/layout.js';
import { PROFILE_KEYS, saveAs, EMPTY_PROFILES } from '../core/profiles.js';

const counter = () => {
  let n = 0;
  return () => `id${++n}`;
};

test('pixelate：每块变成平均色，块外不受影响', () => {
  // 4×2 像素：左边 2×2 一黑一白交替，右边 2×2 纯红
  const px = (r, g, b) => [r, g, b, 255];
  const data = new Uint8ClampedArray([
    ...px(0, 0, 0), ...px(255, 255, 255), ...px(255, 0, 0), ...px(255, 0, 0),
    ...px(255, 255, 255), ...px(0, 0, 0), ...px(255, 0, 0), ...px(255, 0, 0),
  ]);
  pixelate(data, 4, 2, 2);
  assert.deepEqual([...data.slice(0, 4)], [128, 128, 128, 255]);
  assert.deepEqual([...data.slice(4, 8)], [128, 128, 128, 255]);
  assert.deepEqual([...data.slice(8, 12)], [255, 0, 0, 255]);
});

test('pixelate：边缘不满一块也能处理', () => {
  const data = new Uint8ClampedArray(3 * 1 * 4).fill(200);
  pixelate(data, 3, 1, 2);
  assert.ok([...data].every((v) => v === 200));
});

test('wrapLines：中日文按字换行，英文按词换行，保留换行符', () => {
  const measure = (s) => s.length; // 每个字宽 1
  assert.deepEqual(wrapLines('東京都サンプル区', 4, measure), ['東京都サ', 'ンプル区']);
  assert.deepEqual(wrapLines('hello big world', 9, measure), ['hello big', 'world']);
  assert.deepEqual(wrapLines('a\nb', 10, measure), ['a', 'b']);
  assert.deepEqual(wrapLines('abcdefghij', 4, measure), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrapLines('', 4, measure), ['']);
});

test('页面列表：生成、移动、删除、复制、旋转、追加', () => {
  const makeId = counter();
  const a = makePages(0, 3, makeId);
  assert.deepEqual(a.map((p) => p.pageNo), [1, 2, 3]);
  const b = makePages(1, 1, makeId);
  let pages = appendPages(a, b);
  assert.equal(pages.length, 4);
  pages = movePage(pages, 3, 0); // 合并进来的那页放到最前
  assert.deepEqual(pages.map((p) => `${p.src}-${p.pageNo}`), ['1-1', '0-1', '0-2', '0-3']);
  pages = removePage(pages, 2);
  assert.deepEqual(pages.map((p) => `${p.src}-${p.pageNo}`), ['1-1', '0-1', '0-3']);
  pages = duplicatePage(pages, 1, 'dup');
  assert.deepEqual(pages.map((p) => p.id), [pages[0].id, pages[1].id, 'dup', pages[3].id]);
  pages = rotatePage(rotatePage(pages, 0), 0, -180);
  assert.equal(pages[0].rotate, 270);
  assert.equal(movePage(pages, 9, 0), pages); // 越界不动
  assert.ok(Object.isFrozen(pages));
});

test('删页后清理该页的编辑内容', () => {
  const edits = { a: [1], b: [2] };
  assert.deepEqual({ ...keepEditsFor(edits, [{ id: 'b' }]) }, { b: [2] });
});

test('normalizeObject：校验类型、尺寸、字段；不合法返回 null', () => {
  assert.equal(normalizeObject({ id: 'x', type: 'bogus', x: 0, y: 0, w: 10, h: 10 }), null);
  assert.equal(normalizeObject({ id: 'x', type: 'mosaic', x: 0, y: 0, w: 0, h: 10 }), null);
  assert.equal(normalizeObject({ id: 'x', type: 'image', x: 0, y: 0, w: 10, h: 10 }), null); // 缺 imageId
  const m = normalizeObject({ id: 'm', type: 'mosaic', x: 1.234, y: 2, w: 30, h: 10, block: 999 });
  assert.equal(m.block, 40);
  assert.equal(m.x, 1.23);
  const t = normalizeObject({ id: 't', type: 'text', x: 0, y: 0, w: 50, h: 20, text: 'あ', size: 1, color: 'red' });
  assert.equal(t.size, 4);
  assert.equal(t.color, '#000000');
  assert.equal(t.cover, true); // 默认盖白（「盖白+重写」）
});

test('编辑内容：增改删、复制到新页、点选命中最上面的对象', () => {
  const makeId = counter();
  let edits = {};
  edits = addObject(edits, 'p1', { id: 'a', type: 'whiteout', x: 0, y: 0, w: 100, h: 100 });
  edits = addObject(edits, 'p1', { id: 'b', type: 'mosaic', x: 50, y: 50, w: 100, h: 100 });
  edits = addObject(edits, 'p1', { id: 'bad', type: 'mosaic', x: 0, y: 0, w: -1, h: 1 }); // 不合法 → 忽略
  assert.equal(edits.p1.length, 2);
  assert.equal(hitTest(edits.p1, { x: 60, y: 60 }).id, 'b');
  assert.equal(hitTest(edits.p1, { x: 10, y: 10 }).id, 'a');
  assert.equal(hitTest(edits.p1, { x: 300, y: 300 }), null);
  const moved = updateObject(edits, 'p1', 'a', { x: 20, type: 'text' }); // 不能改类型
  assert.equal(moved.p1[0].x, 20);
  assert.equal(moved.p1[0].type, 'whiteout');
  assert.equal(updateObject(edits, 'p1', 'a', { w: -5 }), edits); // 改坏了就不改
  assert.equal(removeObject(edits, 'p1', 'a').p1.length, 1);
  const copied = copyEdits(edits, 'p1', 'p2', makeId);
  assert.equal(copied.p2.length, 2);
  assert.notEqual(copied.p2[0].id, 'a');
  const all = objectsFor(edits, 'p1', [{ id: 'g', type: 'mosaic' }]);
  assert.deepEqual(all.map((o) => o.id), ['g', 'a', 'b']);
});

test('方案里的每页同位置对象：只收盖白/马赛克、去重、限数量', () => {
  const list = [
    { id: 'a', type: 'mosaic', x: 0, y: 0, w: 10, h: 10 },
    { id: 'a', type: 'mosaic', x: 0, y: 0, w: 10, h: 10 },
    { id: 't', type: 'text', x: 0, y: 0, w: 10, h: 10 },
    ...Array.from({ length: 40 }, (_, i) => ({ id: `w${i}`, type: 'whiteout', x: 0, y: 0, w: 10, h: 10 })),
  ];
  const out = normalizeOverlays(list);
  assert.equal(out.length, MAX_GLOBAL_OVERLAYS);
  assert.equal(out[0].id, 'a');
  assert.ok(out.every((o) => o.type !== 'text'));
  assert.deepEqual([...normalizeOverlays('bad')], []);
});

test('水印：默认关闭；数值夹紧；颜色和文字校验', () => {
  assert.deepEqual({ ...normalizeWatermark(null) }, { ...DEFAULT_WATERMARK });
  const w = normalizeWatermark({ enabled: true, text: 'A\nB', size: 999, opacity: 0, angle: 200, color: 'blue' });
  assert.equal(w.enabled, true);
  assert.equal(w.text, 'A B');
  assert.equal(w.size, 200);
  assert.equal(w.opacity, 0.05);
  assert.equal(w.angle, 90);
  assert.equal(w.color, DEFAULT_WATERMARK.color);
});

test('设置和打印方案带上水印与每页同位置对象', () => {
  const s = normalizeSettings({ watermark: { enabled: true, text: 'CAU' }, overlays: [{ id: 'm', type: 'mosaic', x: 1, y: 1, w: 9, h: 9 }] });
  assert.equal(s.watermark.text, 'CAU');
  assert.equal(s.overlays.length, 1);
  assert.equal(normalizeSettings({}).watermark.enabled, false);
  assert.deepEqual([...normalizeSettings({}).overlays], []);
  assert.ok(PROFILE_KEYS.includes('watermark') && PROFILE_KEYS.includes('overlays'));
  const profiles = saveAs(EMPTY_PROFILES, 'p', s, 'x');
  assert.equal(profiles.list[0].settings.watermark.text, 'CAU');
  assert.equal(profiles.list[0].settings.overlays[0].id, 'm');
});

test('撤销/重做', () => {
  const h = createHistory(3);
  assert.equal(h.undo('now'), null);
  h.push('s1');
  h.push('s2');
  assert.equal(h.undo('s3'), 's2');
  assert.equal(h.canRedo, true);
  assert.equal(h.redo('s2'), 's3');
  h.push('s4'); // 新改动清掉重做
  assert.equal(h.canRedo, false);
  h.push('a');
  h.push('b');
  h.push('c');
  assert.equal(h.undo('x'), 'c'); // 超过上限只留最近 3 个
  assert.equal(h.undo('c'), 'b');
  assert.equal(h.undo('b'), 'a');
  assert.equal(h.undo('a'), null);
});

test('旋转：turnRect 四个角度、转四次回到原处；turnObjects 盖白跟着转、文字保持正向', async () => {
  const { turnRect, turnObjects, turnPageEdits } = await import('../core/edits.js');
  const page = { w: 600, h: 800 };
  const r = { x: 10, y: 20, w: 100, h: 50 };
  assert.deepEqual(turnRect(r, 90, page), { x: 730, y: 10, w: 50, h: 100 });
  assert.deepEqual(turnRect(r, 180, page), { x: 490, y: 730, w: 100, h: 50 });
  assert.deepEqual(turnRect(r, 270, page), { x: 20, y: 490, w: 50, h: 100 });
  assert.deepEqual(turnRect(r, 0, page), r);
  // 转 90° 四次：每次页面宽高互换
  let cur = r;
  let size = page;
  for (let i = 0; i < 4; i++) {
    cur = turnRect(cur, 90, size);
    size = { w: size.h, h: size.w };
  }
  assert.deepEqual(cur, r);
  const objs = [
    { id: 'a', type: 'whiteout', ...r },
    { id: 'b', type: 'text', x: 10, y: 20, w: 100, h: 50, text: 'x' },
  ];
  const [white, text] = turnObjects(objs, 90, page);
  assert.deepEqual([white.x, white.y, white.w, white.h], [730, 10, 50, 100]);
  assert.deepEqual([text.w, text.h], [100, 50]); // 文字框不变形
  assert.equal(text.x + text.w / 2, 730 + 25); // 中心点跟着转
  assert.equal(text.y + text.h / 2, 10 + 50);
  const edits = Object.freeze({ p1: Object.freeze(objs), p2: Object.freeze([]) });
  const next = turnPageEdits(edits, 'p1', 90, page);
  assert.notEqual(next, edits);
  assert.equal(next.p2, edits.p2);
  assert.equal(edits.p1[0].x, 10); // 原数据不变
  assert.equal(turnPageEdits(edits, 'p2', 90, page), edits);
});

test('原有文字：文字项换算成页面矩形（含旋转），同一行相邻的拼成一段，点选取最小的', async () => {
  const { itemBox, mergeRuns, hitRun, multiply } = await import('../core/text-runs.js');
  assert.deepEqual(multiply([1, 0, 0, 1, 5, 6], [2, 0, 0, 2, 1, 1]), [2, 0, 0, 2, 6, 7]);
  const vp = [1, 0, 0, -1, 0, 800]; // 600×800 页面，scale 1，不旋转
  const item = (str, x, baseline, size, width) => ({ str, transform: [size, 0, 0, size, x, 800 - baseline], width });
  const b = itemBox(item('abc', 50, 100, 10, 40), vp, { serif: true });
  assert.equal(b.str, 'abc');
  assert.ok(Math.abs(b.x - 50) < 1e-9 && Math.abs(b.y - 91) < 1e-9 && Math.abs(b.w - 40) < 1e-9 && Math.abs(b.h - 11.2) < 1e-9);
  assert.equal(b.serif, true);
  assert.equal(b.horizontal, true);
  assert.equal(itemBox(item('   ', 0, 0, 10, 5), vp), null);
  // 旋转 90°：视口变换 [0,1,1,0,0,0]（scale 1）——文字变成竖着走，外接矩形宽高互换
  const turned = itemBox(item('abc', 50, 100, 10, 40), [0, 1, 1, 0, 0, 0]);
  assert.ok(Math.abs(turned.w - 11.2) < 1e-9 && Math.abs(turned.h - 40) < 1e-9);
  assert.equal(turned.horizontal, false);

  const boxes = [
    item('合同会社', 100, 50, 10, 40),
    item('CAU', 144, 50, 10, 20), // 间隔 4pt（0.4 个字号）→ 同一段，补空格
    item('様', 300, 50, 10, 10), // 远 → 另一段
    item('検査品名', 100, 80, 10, 40), // 下一行
    item('乾燥', 140, 80.5, 10, 20), // 紧挨着 → 同一段，不补空格
  ].map((it) => itemBox(it, vp));
  const runs = mergeRuns(boxes);
  assert.deepEqual(runs.map((r) => r.str), ['合同会社 CAU', '様', '検査品名乾燥']);
  assert.equal(runs[0].w, 64);
  assert.ok(Object.isFrozen(runs) && Object.isFrozen(runs[0]));
  assert.equal(hitRun(runs, { x: 150, y: 45 }).str, '合同会社 CAU');
  assert.equal(hitRun(runs, { x: 250, y: 45 }), null);
  // 重叠时取面积最小的
  const nested = [{ str: 'big', x: 0, y: 0, w: 100, h: 100 }, { str: 'small', x: 10, y: 10, w: 10, h: 10 }];
  assert.equal(hitRun(nested, { x: 15, y: 15 }).str, 'small');
});

test('竖排文字：按整列长度往下排；文字框随内容加宽、到页边后换行加高、只变大不变小', async () => {
  const { itemBox } = await import('../core/text-runs.js');
  const { fitTextRect } = await import('../core/edits.js');
  const vp = [1, 0, 0, -1, 0, 800];
  // pdf.js 竖排：矩阵没转，width = 字号，height = 整列长度
  const col = itemBox({ str: '東京都', transform: [10, 0, 0, 10, 100, 700], width: 10, height: 30 }, vp, { vertical: true });
  assert.equal(col.horizontal, false);
  assert.ok(Math.abs(col.h - 30) < 1e-9, `高 ${col.h}`); // 往下 30pt
  assert.ok(Math.abs(col.y - 100) < 1e-9, `上 ${col.y}`);
  assert.ok(col.w > 10 && col.w < 12); // 一列宽 ≈ 1 个字号
  assert.ok(col.x < 100 && col.x + col.w > 100);

  const measure = (s) => s.length * 6; // 每个字 6pt
  const page = { w: 300, h: 400 };
  const o = { x: 10, y: 10, w: 40, h: 14, size: 10, text: 'abcdefghij' }; // 需要 60 + 3 + 1
  assert.deepEqual(fitTextRect(o, measure, page), { w: 64, h: 14 });
  assert.deepEqual(fitTextRect({ ...o, text: 'ab' }, measure, page), { w: 40, h: 14 }); // 不变小
  const edge = fitTextRect({ ...o, x: 260, text: 'abcdefghij' }, measure, page); // 右边只剩 40pt
  assert.equal(edge.w, 40);
  assert.ok(edge.h > 14, `换行后加高 ${edge.h}`);
  assert.equal(fitTextRect({ ...o, text: 'a\nb\nc' }, measure, page).h, 38); // 1.5 + 2 × 12.5 + 11.5（最后一行只算字身）
});
