// 可视化框选 / 拖动调整 / 打印方案 的端到端实测（在线版，真实鼠标事件）。
// 用法：node tools/e2e-visual.mjs [--shots docs/images] [--chrome <chrome.exe>]
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { launchChrome, waitFor, sleep } from './cdp.mjs';
import { startServer, BASE } from './serve-pages.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const SHOTS = arg('--shots') ? resolve(arg('--shots')) : null;
const PORT = 8797;
const site = `http://127.0.0.1:${PORT}${BASE}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  (${detail})` : ''}`);
};

const server = await startServer({ port: PORT });
const { cdp, close } = await launchChrome({ port: 9339, chrome: arg('--chrome') ?? undefined, args: ['--lang=en-US'] });
try {
  const v = await cdp.openPage(`${site}viewer.html#demo`, { width: 1400, height: 950 });
  const mouse = async (type, x, y, extra = {}) =>
    cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra }, v.sessionId);
  const drag = async (from, to, steps = 8) => {
    await mouse('mousePressed', from.x, from.y);
    for (let i = 1; i <= steps; i++) await mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await mouse('mouseReleased', to.x, to.y);
    await sleep(300);
  };
  const rectOf = (sel) => v.evaluate(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const settings = () => v.evaluate(`window.__lpe.getState().settings`);
  const click = (id) => v.evaluate(`document.getElementById('${id}').click()`);

  await waitFor(() => v.evaluate(`!!window.__lpe`), 10000, '排版页脚本');
  await v.evaluate('window.__lpe.ready');
  await v.evaluate(`(() => { const s = document.getElementById('lang'); s.value = 'en'; s.dispatchEvent(new Event('change')); })()`);
  await waitFor(() => v.evaluate(`!!document.querySelector('#paperWrap canvas.baked')`), 20000, '示例预览');

  // ⓪ 用户反馈的情形：自定义 100×150 纸、整页（没框选）、倍率 94.9%，直接进「拖动调整」
  const setField = (id, value) => v.evaluate(`(() => { const el = document.getElementById('${id}'); el.value = '${value}'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await setField('paper', 'custom');
  await setField('paperW', '100');
  await setField('paperH', '150');
  await setField('scale', '94.9');
  await sleep(1200);
  const inkBox = () => v.evaluate(`(() => {
    const c = document.querySelector('#paperWrap canvas.baked');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height;
    for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) if (d[(y * c.width + x) * 4] < 128) { if (x < x0) x0 = x; if (y < y0) y0 = y; }
    const dpi = window.__lpe.getState().settings.dpi;
    return { left: +(x0 / dpi * 25.4).toFixed(2), top: +(y0 / dpi * 25.4).toFixed(2) };
  })()`);
  const inkBefore = await inkBox();
  await v.evaluate(`document.querySelector('#stageTools [data-view="arrange"]').click()`);
  await waitFor(() => v.evaluate(`document.getElementById('stage').dataset.view === 'arrange' && !!document.querySelector('#paperStage .edit-box:not([hidden])')`), 15000, '拖动调整（整页）');
  await sleep(500);
  const tight = await v.evaluate(`(() => {
    const s = window.__lpe.getState().settings;
    const box = document.querySelector('#paperStage .edit-box').getBoundingClientRect();
    const paper = document.getElementById('paperStage').getBoundingClientRect();
    return { crop: s.crop, ratioW: box.width / paper.width, ratioH: box.height / paper.height };
  })()`);
  check('整页直接进入调整：选框自动收紧到标签（不再比纸大一大圈）', !!tight.crop && tight.ratioW < 1.2 && tight.ratioH < 1.2, JSON.stringify(tight));
  const clickable = (ids) => v.evaluate(`${JSON.stringify(ids)}.map((id) => {
    const el = id.startsWith('#') ? document.querySelector(id) : document.getElementById(id);
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return el === hit || el.contains(hit);
  })`);
  const BUTTONS = ['btnCenter', 'btnFit', 'btnArrangeDone', '#stageTools [data-view="preview"]', 'next'];
  let hits = await clickable(BUTTONS);
  check('工具条在上方、按钮没被选框挡住', hits.every(Boolean), JSON.stringify(hits));
  const barTop = await v.evaluate(`document.getElementById('editBar').getBoundingClientRect().top < document.getElementById('paperStage').getBoundingClientRect().top`);
  check('编辑工具条位于纸张上方', barTop);
  // 极端情况：内容放大到 400%，选框远超纸张，按钮仍然点得到
  await setField('scale', '400');
  await sleep(800);
  hits = await clickable(BUTTONS);
  check('内容放大到 400%：按钮仍然点得到', hits.every(Boolean), JSON.stringify(hits));
  await setField('scale', '94.9');
  await sleep(500);
  // 用真实鼠标点「完成」→ 回到预览；打印位置和收紧前一致
  const done = await rectOf('#btnArrangeDone');
  await mouse('mousePressed', done.x + done.w / 2, done.y + done.h / 2);
  await mouse('mouseReleased', done.x + done.w / 2, done.y + done.h / 2);
  await waitFor(() => v.evaluate(`document.getElementById('stage').dataset.view === 'preview'`), 5000, '点完成回到预览');
  await sleep(1500);
  const inkAfter = await inkBox();
  check('收紧选框不改变打印位置', Math.abs(inkAfter.left - inkBefore.left) < 0.3 && Math.abs(inkAfter.top - inkBefore.top) < 0.3, `${JSON.stringify(inkBefore)} → ${JSON.stringify(inkAfter)}`);
  await click('btnReset');
  await sleep(1200);

  // ① 框选视图：自动识别出内容区域
  await v.evaluate(`document.querySelector('#stageTools [data-view="select"]').click()`);
  await waitFor(() => v.evaluate(`!!document.querySelector('#sourceWrap canvas') && document.querySelector('#sourceWrap .edit-box')?.hidden === false`), 15000, '框选视图');
  const detected = (await settings()).crop;
  check('进入框选：自动识别出标签区域作为初始选区', !!detected && detected.w > 200 && detected.w < 320 && detected.y < 40, JSON.stringify(detected));

  // ② 在页面空白处拖出一个新选区
  const page = await rectOf('#sourceWrap');
  await drag({ x: page.x + page.w * 0.55, y: page.y + page.h * 0.55 }, { x: page.x + page.w * 0.85, y: page.y + page.h * 0.7 });
  const drawn = (await settings()).crop;
  const pageW = 595.28;
  check('空白处拖动：画出新选区（位置大小和鼠标一致）', !!drawn && Math.abs(drawn.x / pageW - 0.55) < 0.02 && Math.abs(drawn.w / pageW - 0.3) < 0.02, JSON.stringify(drawn));
  const readout = await v.evaluate(`document.getElementById('editReadout').textContent`);
  check('框选时显示坐标（mm）', /X [\d.]+ · Y [\d.]+ · W [\d.]+ · H [\d.]+ mm/.test(readout), readout);

  // ③ 拖框内移动选区
  const box = await rectOf('#sourceWrap .edit-box');
  await drag({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, { x: box.x + box.w / 2 - 60, y: box.y + box.h / 2 - 40 });
  const moved = (await settings()).crop;
  check('拖框内：选区整体移动、大小不变', moved.x < drawn.x - 10 && moved.y < drawn.y - 10 && Math.abs(moved.w - drawn.w) < 0.5, JSON.stringify(moved));

  // 回到「自动识别内容」，用标签区域继续
  await click('btnDetect');
  await sleep(1200);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await v.shot(join(SHOTS, 'select-area.png'));
  }

  // ④ 完成 → 拖动调整视图：选区铺满纸张并居中
  await click('btnSelectDone');
  await waitFor(() => v.evaluate(`document.getElementById('stage').dataset.view === 'arrange' && !!document.querySelector('#paperWrap .content-layer')`), 15000, '拖动调整视图');
  await sleep(400);
  let text = await v.evaluate(`document.getElementById('editReadout').textContent`);
  check('完成框选：铺满纸张并自动居中（显示居中标记）', text.includes('centered horizontally') && text.includes('centered vertically'), text);

  // ⑤ 拖动内容：离开中线 → 居中标记消失，边距变化
  const before = await settings();
  const pbox = await rectOf('#paperStage .edit-box');
  await drag({ x: pbox.x + pbox.w / 2, y: pbox.y + pbox.h / 2 }, { x: pbox.x + pbox.w / 2 + 40, y: pbox.y + pbox.h / 2 + 25 });
  const after = await settings();
  text = await v.evaluate(`document.getElementById('editReadout').textContent`);
  check('拖动内容：位置改变、离开中线后不再显示居中', after.marginLeft > before.marginLeft + 2 && !text.includes('centered horizontally'), `${before.marginLeft}→${after.marginLeft} | ${text}`);

  // ⑥ 拖回中线附近（差 3px）→ 自动吸附居中
  const pbox2 = await rectOf('#paperStage .edit-box');
  await drag({ x: pbox2.x + pbox2.w / 2, y: pbox2.y + pbox2.h / 2 }, { x: pbox2.x + pbox2.w / 2 - 37, y: pbox2.y + pbox2.h / 2 - 22 });
  text = await v.evaluate(`document.getElementById('editReadout').textContent`);
  const snapped = await settings();
  check('拖回中线附近：自动吸附居中', text.includes('centered horizontally') && text.includes('centered vertically') && Math.abs(snapped.marginLeft - before.marginLeft) < 0.15, `${snapped.marginLeft} vs ${before.marginLeft}`);

  // ⑦ 拖右下角缩小（等比）+ 滚轮放大
  const pbox3 = await rectOf('#paperStage .edit-box');
  await drag({ x: pbox3.x + pbox3.w, y: pbox3.y + pbox3.h }, { x: pbox3.x + pbox3.w - 80, y: pbox3.y + pbox3.h - 80 });
  const shrunk = await settings();
  check('拖角：等比缩小', shrunk.scale < snapped.scale - 5, `${snapped.scale}% → ${shrunk.scale}%`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pbox3.x + 50, y: pbox3.y + 50, deltaX: 0, deltaY: -100 }, v.sessionId);
  await sleep(300);
  const zoomed = await settings();
  check('滚轮：放大', zoomed.scale > shrunk.scale, `${shrunk.scale}% → ${zoomed.scale}%`);
  await click('btnCenter');
  await sleep(500);
  if (SHOTS) await v.shot(join(SHOTS, 'arrange.png'));

  // ⑧ 完成 → 预览里框外是白的（只打印框内）
  await click('btnArrangeDone');
  await sleep(1500);
  const outside = await v.evaluate(`(() => {
    const c = document.querySelector('#paperWrap canvas.baked');
    const d = c.getContext('2d').getImageData(0, 0, c.width, 6).data;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 128) return false;
    return true;
  })()`);
  check('只打印框内：纸张顶边一条是空白', outside);

  // ⑨ 打印方案：另存为 → 刷新页面后自动套用
  const saved = await settings();
  await click('btnProfileSaveAs');
  await v.evaluate(`(() => { const i = document.getElementById('profileName'); i.value = 'Yu-Packet test'; })()`);
  await click('btnProfileNameOk');
  await sleep(300);
  await v.evaluate(`window.__lpe.ready`);
  await cdp.send('Page.navigate', { url: `${site}viewer.html#demo` }, v.sessionId);
  await sleep(800);
  await waitFor(() => v.evaluate(`!!window.__lpe`), 10000, '重新加载');
  await v.evaluate('window.__lpe.ready');
  const reloaded = await v.evaluate(`({ s: window.__lpe.getState().settings, profile: document.getElementById('profile').selectedOptions[0]?.textContent })`);
  check('方案保存后刷新：默认选中该方案并套用设置', reloaded.profile === 'Yu-Packet test' && reloaded.s.scale === saved.scale && JSON.stringify(reloaded.s.crop) === JSON.stringify(saved.crop), JSON.stringify({ profile: reloaded.profile, scale: reloaded.s.scale }));

  // ⑩ 改设置 → 显示「已修改」；套用后的设置照常能打印
  await v.evaluate(`(() => { const i = document.getElementById('scale'); i.value = '50'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const state = await v.evaluate(`({ text: document.getElementById('profileState').textContent, save: document.getElementById('btnProfileSave').disabled })`);
  check('改了设置：提示已修改、可以保存', state.text.startsWith('Modified') && state.save === false, JSON.stringify(state));
  await click('btnPrint');
  await waitFor(() => v.evaluate(`!document.getElementById('panel').inert && !!document.querySelector('iframe.print-frame')`), 30000, '打印');
  await sleep(400);
  const type = await v.evaluate(`document.querySelector('iframe.print-frame').contentDocument?.contentType`);
  check('框选后打印流程正常', type === 'application/pdf', type);
  check('页面无报错', v.errors.length === 0, v.errors.slice(0, 3).join(' | '));
} finally {
  await close();
  server.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
