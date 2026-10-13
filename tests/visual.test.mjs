import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, computePlacement, normalizeCrop } from '../core/layout.js';
import {
  paperMm, sourceRect, contentBoxOnPaper, settingsFromBox, snapToCenter, fitBoxToPaper, zoomBox, rectFromPoints, clampRect, ptToMm,
} from '../core/visual.js';
import * as P from '../core/profiles.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('normalizeCrop：合法区域保留（两位小数），非法回到整页', () => {
  assert.deepEqual({ ...normalizeCrop({ x: 1.234, y: '2', w: 100, h: 50 }) }, { x: 1.23, y: 2, w: 100, h: 50 });
  assert.equal(normalizeCrop({ x: 0, y: 0, w: 1, h: 50 }), null);
  assert.equal(normalizeCrop({ x: 'a', y: 0, w: 10, h: 10 }), null);
  assert.equal(normalizeCrop(null), null);
  assert.equal(normalizeSettings({ crop: { x: 0, y: 0, w: 0, h: 0 } }).crop, null);
  assert.equal(normalizeSettings({}).crop, null);
});

test('有框选时：框的左上角放在边距处，只保留框内（clip）', () => {
  const crop = { x: 50, y: 20, w: 200, h: 100 };
  const settings = normalizeSettings({ crop, scale: 100, marginLeft: 3, marginTop: 4, dpi: 400 });
  const pl = computePlacement({ settings, srcW: 595, srcH: 842 });
  const k = 400 / 72;
  near(pl.offX + crop.x * pl.scale, (3 / 25.4) * 400);
  near(pl.offY + crop.y * pl.scale, (4 / 25.4) * 400);
  near(pl.clip.x, (3 / 25.4) * 400);
  near(pl.clip.w, crop.w * k);
  near(pl.clip.h, crop.h * k);
});

test('有框选 + 居中：框的中心在纸张中心', () => {
  const crop = { x: 10, y: 10, w: 100, h: 60 };
  const settings = normalizeSettings({ crop, align: 'center', marginLeft: 0, marginTop: 0, scale: 120 });
  const pl = computePlacement({ settings, srcW: 595, srcH: 842 });
  near(pl.clip.x + pl.clip.w / 2, pl.canvasW / 2);
  near(pl.clip.y + pl.clip.h / 2, pl.canvasH / 2);
});

test('有框选 + 自动适配：框铺满纸张（不再检测内容）', () => {
  const crop = { x: 0, y: 0, w: 300, h: 100 };
  const settings = normalizeSettings({ crop, fitMode: 'auto', autoPadding: 0 });
  const pl = computePlacement({ settings, srcW: 595, srcH: 842, bbox: { x: 0, y: 0, w: 1, h: 1 } });
  assert.ok(Math.abs(pl.clip.w - pl.canvasW) < 1e-6 || Math.abs(pl.clip.h - pl.canvasH) < 1e-6);
});

test('纸上内容框 ↔ 设置 往返一致；和渲染用的版面一致', () => {
  const settings = normalizeSettings({ crop: { x: 30, y: 40, w: 250, h: 150 }, scale: 80, marginLeft: 5, marginTop: 6 });
  const src = sourceRect(settings, 595, 842);
  const box = contentBoxOnPaper(settings, src);
  near(box.x, 5);
  near(box.y, 6);
  near(box.w, ptToMm(250) * 0.8);
  const back = settingsFromBox(src, box);
  assert.equal(back.scale, 80);
  assert.equal(back.marginLeft, 5);
  // 渲染画布上框的位置（px）换回 mm 也应一致
  const pl = computePlacement({ settings, srcW: 595, srcH: 842 });
  near((pl.clip.x / pl.dpi) * 25.4, box.x, 1e-6);
  near((pl.clip.w / pl.dpi) * 25.4, box.w, 1e-6);
});

test('居中吸附：靠近中线时吸过去并报告居中', () => {
  const paper = { w: 110, h: 85 };
  const snapped = snapToCenter({ x: 6, y: 10, w: 100, h: 50 }, paper, 1.5);
  assert.equal(snapped.centeredX, true);
  near(snapped.box.x, 5);
  assert.equal(snapped.centeredY, false);
  assert.equal(snapped.box.y, 10);
});

test('铺满纸张：等比、居中、留边', () => {
  const box = fitBoxToPaper({ x: 0, y: 0, w: 200, h: 100 }, { w: 110, h: 85 }, 2);
  near(box.w, 106);
  near(box.h, 53);
  near(box.x, 2);
  near(box.y + box.h / 2, 42.5);
});

test('zoomBox 以中心缩放；rectFromPoints/clampRect 不出界', () => {
  const z = zoomBox({ x: 10, y: 10, w: 20, h: 10 }, 2);
  assert.deepEqual({ ...z }, { x: 0, y: 5, w: 40, h: 20 });
  assert.deepEqual({ ...rectFromPoints({ x: 50, y: 5 }, { x: -3, y: 40 }, 30, 30) }, { x: 0, y: 5, w: 30, h: 25 });
  assert.deepEqual({ ...clampRect({ x: 25, y: -5, w: 10, h: 10 }, 30, 30) }, { x: 20, y: 0, w: 10, h: 10 });
});

test('paperMm 按取整后的页面算', () => {
  const p = paperMm(normalizeSettings({}));
  near(p.w, (314 * 25.4) / 72);
  near(p.h, (241 * 25.4) / 72);
});

test('打印方案：另存为、重名覆盖、修改检测、套用只换方案字段', () => {
  const s1 = normalizeSettings({ scale: 90, lang: 'ja', autoPrint: true });
  let profiles = P.saveAs(P.EMPTY_PROFILES, '  ゆうパケット  送り状 ', s1, 'a');
  assert.equal(profiles.list[0].name, 'ゆうパケット 送り状');
  assert.equal(profiles.active, 'a');
  assert.equal('lang' in profiles.list[0].settings, false);
  const s2 = normalizeSettings({ ...s1, scale: 50 });
  assert.equal(P.isModified(s2, profiles.list[0]), true);
  assert.equal(P.isModified(s1, profiles.list[0]), false);
  profiles = P.saveAs(profiles, 'ゆうパケット 送り状', s2, 'b'); // 重名 → 覆盖，id 不变
  assert.equal(profiles.list.length, 1);
  assert.equal(profiles.list[0].id, 'a');
  assert.equal(profiles.list[0].settings.scale, 50);
  const applied = P.applyProfile(normalizeSettings({ lang: 'zh', scale: 10 }), profiles.list[0]);
  assert.equal(applied.scale, 50);
  assert.equal(applied.lang, 'zh');
  assert.throws(() => P.saveAs(profiles, '   ', s1));
});

test('打印方案：删除当前方案后无选中；坏数据被清理', () => {
  let profiles = P.saveAs(P.EMPTY_PROFILES, 'A', normalizeSettings({}), 'a');
  profiles = P.saveAs(profiles, 'B', normalizeSettings({}), 'b');
  profiles = P.remove(profiles, 'b');
  assert.equal(profiles.active, null);
  assert.equal(profiles.list.length, 1);
  const cleaned = P.normalizeProfiles({ list: [{ id: 'x', name: 'ok', settings: { scale: 'bad' } }, { id: 'x', name: 'dup' }, null, { id: 'y', name: '' }], active: 'zzz' });
  assert.equal(cleaned.list.length, 1);
  assert.equal(cleaned.list[0].settings.scale, 93);
  assert.equal(cleaned.active, null);
  assert.equal(P.normalizeProfiles('garbage'), P.EMPTY_PROFILES);
});
