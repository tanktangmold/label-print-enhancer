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
