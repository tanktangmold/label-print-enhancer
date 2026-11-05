// 「编辑 PDF」端到端实测（在线版，真实鼠标/键盘事件）：合并、排序、旋转、复制、删页、盖白、马赛克、文字、图片、水印、撤销、记住设置、打印。
// 用法：node tools/e2e-edit.mjs [--shots docs/images] [--chrome <chrome.exe>]
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { launchChrome, waitFor, sleep } from './cdp.mjs';
import { turnRect } from '../core/edits.js';
import { startServer, BASE } from './serve-pages.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const SHOTS = arg('--shots') ? resolve(arg('--shots')) : null;
const PORT = 18799;
const site = `http://127.0.0.1:${PORT}${BASE}`;
const FIXTURE_PDF = resolve('tests/fixtures/a4-label.pdf'); // 3 页
const FIXTURE_IMG = resolve('icons/128.png');
const PAGE = { w: 595.28, h: 841.89 }; // 示例 PDF 是 A4（pt）

// 示例标签上的几块区域（pt，页面左上为原点）
const R_WHITE = { x: 20, y: 20, w: 120, h: 40 };
const R_MOSAIC = { x: 150, y: 95, w: 130, h: 70 };
const R_TEXT = { x: 300, y: 320, w: 220, h: 40 };

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  (${detail})` : ''}`);
};

const server = await startServer({ port: PORT });
const { cdp, close } = await launchChrome({ port: 9343, chrome: arg('--chrome') ?? undefined, args: ['--lang=en-US'] });
try {
  const v = await cdp.openPage(`${site}viewer.html#demo`, { width: 1400, height: 950 });
  const sid = v.sessionId;
  const mouse = (type, x, y) =>
    cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, sid);
  const drag = async (from, to, steps = 8) => {
    await mouse('mousePressed', from.x, from.y);
    for (let i = 1; i <= steps; i++) await mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await mouse('mouseReleased', to.x, to.y);
    await sleep(300);
  };
  const key = async (k, code, vk, modifiers = 0) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers }, sid);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers }, sid);
    await sleep(250);
  };
  const CTRL = 2;
  const ev = (expr) => v.evaluate(`(() => { const s = window.__lpe.getState(); return ${expr}; })()`);
  const click = (sel) => v.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const setFiles = async (selector, files) => {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 }, sid);
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector }, sid);
    await cdp.send('DOM.setFileInputFiles', { nodeId, files }, sid);
  };
  const pageRect = () => v.evaluate(`(() => { const r = document.getElementById('editPage').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const at = (r, x, y) => ({ x: r.x + (x / PAGE.w) * r.w, y: r.y + (y / PAGE.h) * r.h });
  const dragRect = async (rect) => {
    const r = await pageRect();
    await drag(at(r, rect.x, rect.y), at(r, rect.x + rect.w, rect.y + rect.h));
  };
  /** 编辑画布上某区域（pt，向内缩 3pt 防边缘抗锯齿）的统计：深色像素数、非白像素数、行内明暗跳变数。 */
  const stats = (rect, { pageW = PAGE.w, canvas = '#editCanvas' } = {}) => v.evaluate(`(() => {
    const c = document.querySelector('${canvas}');
    const k = c.width / ${pageW};
    const x = Math.round((${rect.x} + 3) * k), y = Math.round((${rect.y} + 3) * k);
    const w = Math.round((${rect.w} - 6) * k), h = Math.round((${rect.h} - 6) * k);
    const d = c.getContext('2d').getImageData(x, y, w, h).data;
    let dark = 0, ink = 0, edges = 0;
    for (let j = 0; j < h; j++) {
      let prev = null;
      for (let i = 0; i < w; i++) {
        const p = (j * w + i) * 4;
        const g = (d[p] + d[p + 1] + d[p + 2]) / 3;
        if (g < 128) dark++;
        if (g < 245) ink++;
        const b = g < 128;
        if (prev !== null && b !== prev) edges++;
        prev = b;
      }
    }
    return { dark, ink, edges };
  })()`);
  const pageEdits = () => ev(`s.edits[s.doc.pages[s.page - 1].id] ?? []`);
  const settled = () => sleep(700); // 等编辑后的重画（预览 150ms 防抖 + 渲染）

  await waitFor(() => v.evaluate(`!!window.__lpe`), 10000, '排版页脚本');
  await v.evaluate('window.__lpe.ready');
  await v.evaluate(`(() => { const s = document.getElementById('lang'); s.value = 'en'; s.dispatchEvent(new Event('change')); })()`);
  await waitFor(() => v.evaluate(`!!document.querySelector('#paperWrap canvas.baked')`), 20000, '示例预览');

  // ① 进入编辑 PDF
  await click('#stageTools [data-view="edit"]');
  await waitFor(
    () => v.evaluate(`!document.getElementById('editView').hidden && document.querySelectorAll('#thumbList .thumb canvas').length === 3 && document.getElementById('editCanvas').width > 0`),
    20000,
    '编辑视图',
  );
  await settled();
  const layout = await v.evaluate(`({ tabsVisible: document.querySelector('#stageTools').getBoundingClientRect().top >= document.getElementById('stage').getBoundingClientRect().top, view: document.getElementById('stage').dataset.view, paperHidden: getComputedStyle(document.getElementById('paperStage')).display === 'none', thumbs: document.querySelectorAll('#thumbList .thumb').length, current: document.querySelector('#thumbList .thumb.current .thumb-no')?.textContent })`);
  check('进入编辑 PDF：3 页缩略图，当前第 1 页，顶部切换按钮可见', layout.tabsVisible && layout.view === 'edit' && layout.paperHidden && layout.thumbs === 3 && layout.current === '1', JSON.stringify(layout));

  // ② 盖白
  const beforeWhite = await stats(R_WHITE);
  await click('[data-tool="whiteout"]');
  const hint = await v.evaluate(`document.querySelector('#editProps .prop-hint')?.textContent ?? ''`);
  await dragRect(R_WHITE);
  await settled();
  const whiteObjs = await pageEdits();
  const afterWhite = await stats(R_WHITE);
  check('盖白：画出区域后原内容被盖掉', beforeWhite.dark > 50 && afterWhite.ink === 0 && whiteObjs.length === 1 && whiteObjs[0].type === 'whiteout', `${beforeWhite.dark} → ${afterWhite.ink}，提示「${hint.slice(0, 30)}…」`);

  // ③ 每页同位置：存进设置（打印方案），第 2 页同一位置也盖白
  await click('#propAllPages');
  await settled();
  const globalState = await ev(`({ overlays: s.settings.overlays.length, edits: (s.edits[s.doc.pages[0].id] ?? []).length })`);
  await click('#thumbList .thumb:nth-child(2)');
  await waitFor(() => ev(`s.page === 2`), 5000, '切到第 2 页');
  await settled();
  const page2 = await stats(R_WHITE);
  check('每页同位置：移进设置，第 2 页同一位置也被盖白', globalState.overlays === 1 && globalState.edits === 0 && page2.ink === 0, `${JSON.stringify(globalState)}，第 2 页 ${page2.ink}`);
  await click('#btnUndo');
  await settled();
  const undone = await ev(`({ overlays: s.settings.overlays.length, edits: (s.edits[s.doc.pages[0].id] ?? []).length })`);
  const page2Undone = await stats(R_WHITE);
  await click('#btnRedo');
  await settled();
  const redone = await ev(`s.settings.overlays.length`);
  check('撤销 / 重做「每页同位置」', undone.overlays === 0 && undone.edits === 1 && page2Undone.dark > 50 && redone === 1, `${JSON.stringify(undone)}，第 2 页 ${page2Undone.dark}，重做后 ${redone}`);
  await click('#thumbList .thumb:nth-child(1)');
  await waitFor(() => ev(`s.page === 1`), 5000, '回到第 1 页');
  await settled();

  // ④ 马赛克：明暗跳变大幅减少（原文字笔画被打成色块），但不是空白
  const beforeMosaic = await stats(R_MOSAIC);
  await click('[data-tool="mosaic"]');
  await dragRect(R_MOSAIC);
  await settled();
  const afterMosaic = await stats(R_MOSAIC);
  const mosaicObj = (await pageEdits()).find((o) => o.type === 'mosaic');
  check('马赛克：区域被打成色块（细节去掉、不是空白）', !!mosaicObj && afterMosaic.edges < beforeMosaic.edges * 0.5 && afterMosaic.ink > 0, `跳变 ${beforeMosaic.edges} → ${afterMosaic.edges}`);
  await v.evaluate(`(() => { const r = document.getElementById('propBlock'); r.value = '12'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); })()`);
  await settled();
  const coarser = await stats(R_MOSAIC);
  const block = (await pageEdits()).find((o) => o.type === 'mosaic')?.block;
  check('马赛克颗粒调大：色块更粗', block === 12 && coarser.edges < afterMosaic.edges, `block ${block}，跳变 ${afterMosaic.edges} → ${coarser.edges}`);

  // ⑤ 文字：拖出文字框 → 直接打字（焦点不丢）→ 改字号
  await click('[data-tool="text"]');
  await dragRect(R_TEXT);
  await waitFor(() => v.evaluate(`document.activeElement?.id === 'propText'`), 5000, '文字输入框获得焦点');
  await cdp.send('Input.insertText', { text: 'Hello' }, sid);
  await settled();
  await cdp.send('Input.insertText', { text: ' 123' }, sid);
  await settled();
  const typed = await v.evaluate(`({ focus: document.activeElement?.id, value: document.getElementById('propText')?.value })`);
  const textObj = (await pageEdits()).find((o) => o.type === 'text');
  const textInk = await stats(R_TEXT);
  check('文字：拖出文字框直接输入，输入中焦点不丢、页面上画出文字', typed.focus === 'propText' && textObj?.text === 'Hello 123' && textInk.dark > 30, `${JSON.stringify(typed)}，深色 ${textInk.dark}`);
  const blank = at(await pageRect(), 450, 760); // 页面下方空白处
  await mouse('mousePressed', blank.x, blank.y);
  await mouse('mouseReleased', blank.x, blank.y);
  await settled();
  await click('#btnUndo');
  await settled();
  const afterUndoText = (await pageEdits()).filter((o) => o.type === 'text').map((o) => o.text);
  await click('#btnRedo');
  await settled();
  const afterRedoText = (await pageEdits()).filter((o) => o.type === 'text').map((o) => o.text);
  check('打字后点页面空白再撤销：只撤销这次输入，文字框还在', afterUndoText.join() === 'Text' && afterRedoText.join() === 'Hello 123', `撤销后 ${JSON.stringify(afterUndoText)}，重做后 ${JSON.stringify(afterRedoText)}`);
  const tc = at(await pageRect(), R_TEXT.x + R_TEXT.w / 2, R_TEXT.y + R_TEXT.h / 2);
  await mouse('mousePressed', tc.x, tc.y); // 点文字框重新选中
  await mouse('mouseReleased', tc.x, tc.y);
  await waitFor(() => v.evaluate(`!!document.getElementById('propSize')`), 5000, '选中文字框');
  await v.evaluate(`(() => { const i = document.getElementById('propSize'); i.value = '20'; i.dispatchEvent(new Event('change')); })()`);
  await settled();
  const bigger = await stats(R_TEXT);
  const size = (await pageEdits()).find((o) => o.type === 'text')?.size;
  check('文字：字号改大，笔画变多', size === 20 && bigger.dark > textInk.dark, `size ${size}，深色 ${textInk.dark} → ${bigger.dark}`);

  // ⑥ 图片：加照片（放在页面中间、选中）
  await setFiles('#imageInput', [FIXTURE_IMG]);
  await waitFor(async () => (await pageEdits()).some((o) => o.type === 'image'), 5000, '加图片');
  await settled();
  const img = (await pageEdits()).find((o) => o.type === 'image');
  const imgInk = await stats(img);
  check('图片：加到页面中间并选中', imgInk.ink > 100 && Math.abs(img.x + img.w / 2 - PAGE.w / 2) < 2, `${Math.round(img.w)}×${Math.round(img.h)}pt，非白 ${imgInk.ink}`);

  // ⑦ 拖动对象移动
  const r = await pageRect();
  const center = at(r, img.x + img.w / 2, img.y + img.h / 2);
  await drag(center, at(r, img.x + img.w / 2 + 60, img.y + img.h / 2 + 40));
  await settled();
  const moved = (await pageEdits()).find((o) => o.type === 'image');
  check('拖动图片：位置跟着鼠标走', Math.abs(moved.x - img.x - 60) < 3 && Math.abs(moved.y - img.y - 40) < 3, `(${Math.round(img.x)},${Math.round(img.y)}) → (${Math.round(moved.x)},${Math.round(moved.y)})`);
  await key('ArrowRight', 'ArrowRight', 39);
  await settled();
  await key('ArrowRight', 'ArrowRight', 39);
  await settled();
  const nudged = (await pageEdits()).find((o) => o.type === 'image');
  const pageAfterNudge = await ev(`s.page`);
  check('方向键连续微移两次（不会变成翻页）', Math.abs(nudged.x - moved.x - 1) < 0.01 && pageAfterNudge === 1, `x ${moved.x} → ${nudged.x}，第 ${pageAfterNudge} 页`);

  // ⑧ Delete 删除 / Ctrl+Z 撤销 / Ctrl+Y 重做
  const count = async () => (await pageEdits()).length;
  const n0 = await count();
  await key('Delete', 'Delete', 46);
  const n1 = await count();
  await key('z', 'KeyZ', 90, CTRL);
  const n2 = await count();
  await key('y', 'KeyY', 89, CTRL);
  const n3 = await count();
  await key('z', 'KeyZ', 90, CTRL);
  const n4 = await count();
  check('Delete 删除选中、Ctrl+Z 撤销、Ctrl+Y 重做', n1 === n0 - 1 && n2 === n0 && n3 === n0 - 1 && n4 === n0, [n0, n1, n2, n3, n4].join(' → '));
  await settled();
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await v.evaluate(`document.activeElement?.blur()`);
    await v.shot(join(SHOTS, 'edit-pdf.png'));
  }

  // ⑨ 合并：追加 3 页 PDF + 1 张图片；能撤销
  const ids0 = await ev(`s.doc.pages.map((p) => p.id)`);
  await setFiles('#appendInput', [FIXTURE_PDF, FIXTURE_IMG]);
  await waitFor(() => ev(`s.doc.pages.length === 7`), 15000, '合并');
  await waitFor(() => v.evaluate(`document.querySelectorAll('#thumbList .thumb canvas').length === 7`), 15000, '合并后缩略图');
  const merged = await ev(`({ n: s.doc.pages.length, sources: s.doc.sources.length, kinds: s.doc.sources.map((x) => x.kind), name: document.getElementById('docName').textContent })`);
  check('合并：追加 PDF（3 页）+ 图片（1 页）→ 共 7 页', merged.n === 7 && merged.sources === 3 && merged.kinds.join() === 'pdf,pdf,image', JSON.stringify(merged));
  await click('#btnUndo');
  await settled();
  const undoMerge = await ev(`s.doc.pages.length`);
  await click('#btnRedo');
  await settled();
  check('撤销 / 重做合并', undoMerge === 3 && (await ev(`s.doc.pages.length`)) === 7, `${undoMerge} → 7`);

  // ⑩ 页面操作：下移、拖动排序、旋转、复制、删除
  await click('#thumbList .thumb:nth-child(1) .thumb-btn:nth-child(2)'); // ↓
  await settled();
  const afterDown = await ev(`({ ids: s.doc.pages.map((p) => p.id), page: s.page })`);
  check('下移第 1 页：顺序交换，当前页跟着走', afterDown.ids[0] === ids0[1] && afterDown.ids[1] === ids0[0] && afterDown.page === 2, `当前第 ${afterDown.page} 页`);
  await v.evaluate(`(() => {
    const items = document.querySelectorAll('#thumbList .thumb');
    const dt = new DataTransfer();
    items[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    items[2].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    items[2].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    items[0].dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  })()`);
  await settled();
  const afterDrop = await ev(`s.doc.pages.map((p) => p.id)`);
  check('拖动缩略图排序：第 1 页拖到第 3 位', afterDrop[2] === afterDown.ids[0] && afterDrop[0] === afterDown.ids[1] && afterDrop[1] === afterDown.ids[2]);
  const mosaicBefore = await ev(`(s.edits[s.doc.pages[0].id] ?? []).find((o) => o.type === 'mosaic')`);
  await click('#thumbList .thumb:nth-child(1) .thumb-btn:nth-child(3)'); // ⟳
  await settled();
  const rot = await ev(`s.doc.pages[0].rotate`);
  const mosaicAfter = await ev(`(s.edits[s.doc.pages[0].id] ?? []).find((o) => o.type === 'mosaic')`);
  const expected = turnRect(mosaicBefore, 90, PAGE);
  await click('#thumbList .thumb:nth-child(1)');
  await waitFor(() => ev(`s.page === 1`), 5000, '转到旋转后的第 1 页');
  await settled();
  const rotatedMosaic = await stats(expected, { pageW: PAGE.h });
  check(
    '旋转页面：这一页的马赛克跟着内容一起转',
    rot === 90 && ['x', 'y', 'w', 'h'].every((k) => Math.abs(mosaicAfter[k] - expected[k]) < 0.01) && rotatedMosaic.edges < beforeMosaic.edges * 0.5 && rotatedMosaic.ink > 0,
    `rotate ${rot}，跳变 ${rotatedMosaic.edges}`,
  );
  const editedIndex = await ev(`s.doc.pages.findIndex((p) => (s.edits[p.id] ?? []).length > 0)`);
  await click(`#thumbList .thumb:nth-child(${editedIndex + 1}) .thumb-btn:nth-child(4)`); // ⧉
  await settled();
  const dup = await ev(`(() => { const a = s.doc.pages[${editedIndex}], b = s.doc.pages[${editedIndex + 1}]; return { n: s.doc.pages.length, same: a.src === b.src && a.pageNo === b.pageNo && a.id !== b.id, ea: (s.edits[a.id] ?? []).length, eb: (s.edits[b.id] ?? []).length }; })()`);
  check('复制页面：编辑内容一起复制', dup.n === 8 && dup.same && dup.ea > 0 && dup.ea === dup.eb, JSON.stringify(dup));
  await click('#thumbList .thumb:last-child .thumb-btn:nth-child(5)'); // ✕
  await settled();
  const afterDelete = await ev(`({ n: s.doc.pages.length, last: s.doc.sources[s.doc.pages.at(-1).src].kind })`);
  check('删除最后一页（图片页）', afterDelete.n === 7 && afterDelete.last === 'pdf', JSON.stringify(afterDelete));
  await click('#thumbList .thumb:nth-child(7)');
  await settled();
  const tabs = await v.evaluate(`({ stageScroll: document.getElementById('stage').scrollTop, listScroll: document.getElementById('thumbList').scrollTop })`);
  check('选中靠后的页面：只滚动缩略图列表，顶部按钮不被滚走', tabs.stageScroll === 0 && tabs.listScroll > 0, JSON.stringify(tabs));

  // ⑪ 输出：页数 = 编辑后的页数；每页都是纸张大小
  const b64 = await v.evaluate(`(async () => {
    const bytes = await window.__lpe.buildOutput();
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  })()`);
  const outDoc = await PDFDocument.load(Buffer.from(b64, 'base64'));
  const sizes = [...new Set(outDoc.getPages().map((p) => `${p.getWidth()}×${p.getHeight()}`))];
  check('输出 PDF：7 页、全部是纸张大小（314×241pt）', outDoc.getPageCount() === 7 && sizes.join() === '314×241', `${outDoc.getPageCount()} 页 ${sizes.join(', ')}`);

  // ⑫ 水印：编辑视图点「水印」→ 回到预览、亮出水印设置；打开后预览变化
  await click('[data-tool="watermark"]');
  await sleep(400);
  const wmUi = await v.evaluate(`({ view: document.getElementById('stage').dataset.view, focus: document.activeElement?.id })`);
  const inkPreview = () => v.evaluate(`(() => {
    const c = document.querySelector('#paperWrap canvas.baked');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 16) if (d[i] < 128) n++; return n;
  })()`);
  await settled();
  const inkNoWm = await inkPreview();
  await click('#wmEnabled');
  await v.evaluate(`(() => { const i = document.getElementById('wmText'); i.value = 'COPY'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await settled();
  await waitFor(() => v.evaluate(`!!document.querySelector('#paperWrap canvas.baked')`), 10000, '水印预览');
  await sleep(500);
  const inkWm = await inkPreview();
  const wm = await ev(`s.settings.watermark`);
  check('水印：从编辑视图跳到水印设置，打开后预览上出现水印', wmUi.view === 'preview' && wmUi.focus === 'wmEnabled' && wm.enabled && wm.text === 'COPY' && inkWm > inkNoWm, `${JSON.stringify(wmUi)}，墨量 ${inkNoWm} → ${inkWm}`);

  // ⑬ 换语言：编辑工具跟着换
  await v.evaluate(`(() => { const s = document.getElementById('lang'); s.value = 'ja'; s.dispatchEvent(new Event('change')); })()`);
  const ja = await v.evaluate(`document.querySelector('[data-tool="mosaic"]').textContent + ' / ' + document.querySelector('#stageTools [data-view="edit"]').textContent`);
  await v.evaluate(`(() => { const s = document.getElementById('lang'); s.value = 'en'; s.dispatchEvent(new Event('change')); })()`);
  check('界面语言：编辑工具也换成日文', ja === 'モザイク / PDF編集', ja);

  // ⑭ 打印
  await click('#btnPrint');
  await waitFor(() => v.evaluate(`!document.getElementById('panel').inert && !!document.querySelector('iframe.print-frame')`), 60000, '打印');
  await sleep(400);
  const type = await v.evaluate(`document.querySelector('iframe.print-frame').contentDocument?.contentType`);
  check('编辑后打印流程正常', type === 'application/pdf', type);

  // ⑮ 重新打开：每页同位置盖白 + 水印记住了；文字/图片/合并只对当时的文件
  await v.evaluate(`new Promise((ok) => setTimeout(ok, 500))`); // 让设置写入
  await cdp.send('Page.reload', {}, sid);
  await sleep(500);
  await waitFor(() => v.evaluate(`!!window.__lpe`), 10000, '重新打开');
  await v.evaluate('window.__lpe.ready');
  await waitFor(() => v.evaluate(`!!document.querySelector('#paperWrap canvas.baked')`), 20000, '重新打开后的预览');
  const kept = await ev(`({ overlays: s.settings.overlays.map((o) => o.type), wm: s.settings.watermark.enabled && s.settings.watermark.text, pages: s.doc.pages.length, edits: Object.keys(s.edits).length })`);
  if (SHOTS) await v.shot(join(SHOTS, 'watermark.png'));
  check('重新打开：每页同位置盖白和水印还在，其余编辑不带过来', kept.overlays.join() === 'whiteout' && kept.wm === 'COPY' && kept.pages === 3 && kept.edits === 0, JSON.stringify(kept));
  await v.evaluate(`(() => { const r = document.getElementById('rotate'); r.value = '90'; r.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await click('#stageTools [data-view="select"]');
  await waitFor(() => v.evaluate(`!!document.querySelector('#sourceWrap canvas') && window.__lpe.getState().settings.rotate === 90`), 15000, '框选视图（旋转 90°）');
  await sleep(500);
  const turnedWhite = await stats(turnRect(R_WHITE, 90, PAGE), { pageW: PAGE.h, canvas: '#sourceWrap canvas' });
  check('排版旋转 90°：每页同位置的盖白跟着转，仍盖住原来那块内容', turnedWhite.ink === 0, `非白 ${turnedWhite.ink}`);
  check('页面无报错', v.errors.length === 0, v.errors.slice(0, 3).join(' | '));
} finally {
  await close();
  server.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
